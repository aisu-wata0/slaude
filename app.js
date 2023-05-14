import express from 'express';
import axios from 'axios';
import FormData from 'form-data';
import WebSocket from 'ws';
import config from './config.js';
import splitMessageInTwo from './utils.js';

const app = express();


const typingString = "\n\n_Typing…_";

const maxMessageLength = 12000;
// Overhead to take into account when splitting messages, for example, the length of "Human:"
const messageLengthOverhead = 20;

var lastMessage = '';

var streamQueue = Promise.resolve();

app.use(express.json());

/** SillyTavern calls this to check if the API is available, the response doesn't really matter */
app.get('/(.*)/models', (req, res) => {
    res.json({
        object: 'list',
        data: [{id: 'claude-v1', object: 'model', created: Date.now(), owned_by: 'anthropic', permission: [], root: 'claude-v1', parent: null}]
    });
});

/** 
 * SillyTavern calls this endpoint for prompt completion, if streaming is enabled it will stream Claude's response back to SillyTavern
 * as it is being typed on Slack, otherwise it will just wait until Claude stops typing and then return the entire message at once as an OpenAI completion result
 * Does the following:
 * - Build the prompt messages from the request data
 * - Post a new message with the first prompt chunk in the configured Slack channel, save the Slack timestamp of the created message
 * - Post one message as reply to the first message for each prompt chunk, creating a thread from the first message
 * - Once all parts of the prompt are sent, open WebSocket connection and register event handlers to start listening for Claude's response
 * - Send one final message to the thread that pings Claude, causing him to start generating a response using all messages currently in the thread as context
 * After that the WS event handlers will wait for Claude to finish responding then write his message back into the Response for SillyTavern
 */
app.post('/(.*)/chat/completions', async (req, res, next) => {
    if (!('messages' in req.body)) {
        throw new Error('Completion request not in expected format, make sure SillyTavern is set to use OpenAI.');
    }

    try {
        let stream = req.body.stream ?? false;
        let promptMessages = buildSlackPromptMessages(req.body.messages);

        let tsThread = await createSlackThread(promptMessages[0]);

        if (tsThread === null || tsThread === undefined) {
            throw new Error("First message did not return a thread timestamp. Make sure that CHANNEL is set to a channel ID that both your Slack user and Claude have access to.")
        }

        console.log(`Created thread with ts ${tsThread}`);

        if (promptMessages.length > 1) {
            for (let i = 1; i < promptMessages.length; i++) {
                await createSlackReply(promptMessages[i], tsThread);
                console.log(`Created ${i}. reply on thread ${tsThread}`);
            }
        }

        let ws = await openWebSocketConnection();
        let timeout = null;

        if (stream) {
            console.log("Opened stream for Claude's response.");
            streamQueue = Promise.resolve();
            ws.on("message", (message) => {
                streamQueue = streamQueue.then(streamNextClaudeResponseChunk.bind(this, message, res));
            });

            timeout = setTimeout(() => {
                console.log("Streaming response taking too long, closing stream.")
                finishStream(res);
            }, 2*60*1000);
        } else {
            console.log("Awaiting Claude's response.");
            ws.on("message", (message) => {
                getClaudeResponse(message, res);
            });
        }
        ws.on("error", (err) => {
            console.error(err);
        });
        ws.on("close", (code, reason) => {
            if (code !== 1000 && code !== 1005) {
                console.log(`Socket closed with code ${code} and reason ${reason}`);
            }
        });

        res.on("finish", () => {
            ws.close();
            console.log("Finished returning Claude's response.");
            if (timeout) {
                clearTimeout(timeout);
            }
        });

        await createClaudePing(tsThread);
        console.log(`Created Claude ping on thread ${tsThread}`);
    } catch (error) {
        console.error(error);
        next(error);
    }
});

app.listen(config.PORT, () => {
    console.log(`Slaude is running at http://localhost:${config.PORT}`);
    checkConfig();
});

function checkConfig() {
    if (config.TOKEN.length <= 9 || !config.TOKEN.startsWith("xoxc")) {
        console.warn("TOKEN looks abnormal, please verify TOKEN setting");
    }
    if (config.COOKIE.length <= 9 || !config.COOKIE.startsWith("xoxd")) {
        console.warn("COOKIE looks abnormal, please verify COOKIE setting");
    }
    if (config.TEAM_ID.includes('.slack.com')) {
        console.warn("TEAM_ID needs to be the part before '.slack.com', not the entire URL.");
    }
    if (!config.CHANNEL.startsWith('C')) {
        console.warn("Your CHANNEL might be wrong, please make sure you copy the channel ID of a channel you and Claude both have access to, like #random.");
    }
    if (config.CHANNEL.startsWith('D')) {
        console.warn("It looks like you might have put Claude's DM channel ID into the CHANNEL setting.");
    }
    if (!config.CLAUDE_USER.startsWith('U')) {
        console.warn("Your CLAUDE_USER might be wrong, please make sure you copied Claude's Member ID, NOT his Channel ID");
    }
    if (config.CLAUDE_USER.startsWith('D')) {
        console.warn("It looks like you might have put Claude's DM channel ID into the CLAUDE_USER setting, plase make sure you use his Member ID instead.");
    }
    if (config.PING_MESSAGE.length === 0) {
        console.warn('PING_MESSAGE should not be completely empty, otherwise Claude will not produce a response. If you want nothing in the ping message except for the Claude ping, make sure there is at least an empty space in the string, like " "');
    }
}

/** Opens a WebSocket connection to Slack with an awaitable Promise */
function openWebSocketConnection() {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject('Timed out establishing WebSocket connection.');
        }, 10000);

        var ws = new WebSocket(`wss://wss-primary.slack.com/?token=${config.TOKEN}`, {
            headers: {
                'Cookie': `d=${config.COOKIE};`,
                'User-Agent':	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0'
            }
        });

        ws.on("open", () => {
            resolve(ws);
        })

        ws.on("close", (code, reason) => {
            if (code !== 1000 && code !== 1005) {
                console.error(`WebSocket connection closed abnormally with code ${code}. Your cookie and/or token might be incorrect or expired.`)
            }
        })
    });
}

/** 
 * Hacky bullshit that compares the last message we got from Slack with the current one and returns the difference.
 * Only needed for streaming.
 */
function getNextChunk(text) {
    // Current and last message are identical, can skip streaming a chunk.
    if (text === lastMessage) {
        return '';
    }

    // if the next message doesn't have the entire previous message in it we received something out of order and dismissing it is the safest option
    if (!text.includes(lastMessage)) {
        return '';
    }

    let chunk = text.slice(lastMessage.length, text.length);
    lastMessage = text;
    return chunk;
}

/** Strips the "Typing..." string from the end of Claude's messages. */
function stripTyping(text) {
    return text.slice(0, text.length-typingString.length);
}

const blacklisted_threads = new Set();
// better way would be to register whitelisted threads, when you create them
// and them unregistering them when you're done getting the message
function isMessageValid(messsageData) {
    if (!messsageData.message) {
        return true
    }
    let senderID = messsageData.user;
    if (!senderID) {
        if (messsageData.message.user) {
            senderID = messsageData.message.user
        }
    }
    if (senderID && senderID !== config.CLAUDE_USER) {
        // if not from Claude, happens sometimes if last thread is still going somehow
        // console.log("Message from socket not from Claude but from ID =", senderID, JSON.stringify(messsageData.message.text.slice(0, 55).trim()))
        return false;
    }
    if (messsageData.message.thread_ts && blacklisted_threads.has(messsageData.message.thread_ts)) {
        console.log("Intended: Ignoring Claude sending message in old thread ", messsageData.message.thread_ts)
        // console.log(JSON.stringify(messsageData.message.text.slice(0, 55).trim()))
        return false
    }
    return true;
}

/** 
 * Used as a callback for WebSocket to get the next chunk of the response Claude is currently typing and
 * write it into the response for SillyTavern. Used for streaming.
 * @param {*} message The WebSocket message object
 * @param {*} res The Response object for SillyTavern's request
 */
function streamNextClaudeResponseChunk(message, res) {
    return new Promise((resolve, reject) => {
        try {
            let data = JSON.parse(message);
            if (!isMessageValid(data)) {
                resolve();
                return;
            }
            if (data.subtype === 'message_changed') {
                let text = data.message.text;
                let stillTyping = text.endsWith(typingString);
                text = stillTyping ? stripTyping(text) : text;
                const textUncropped = text
                text = cropText(text)
                if (textUncropped.length > text.length) {
                    stillTyping = false
                    if (data.message.thread_ts) {
                        blacklisted_threads.add(data.message.thread_ts);
                        console.log("Message thread stopped early ", data.message.thread_ts)
                    }
                }
                let chunk = getNextChunk(text);

                if (chunk.length === 0 && stillTyping) {
                    resolve();
                    return;
                }
                
                let streamData = {
                    choices: [{
                        delta: {
                            content: chunk
                        }
                    }]
                };
                try {
                    res.write('\ndata: ' + JSON.stringify(streamData));
                } catch (error) {
                    console.error(error)
                }
    
                if (!stillTyping) {
                    finishStream(res);
                }
            }
            resolve();
        } catch (error) {
            console.error('Error parsing Slack WebSocket message');
            reject(error);
        }
    });
}

function cropText(text) {
    if (config.stop_message_when_string_is_found) {
        for (let summaryCrop of config.stop_message_when_string_is_found) {
            let cropIdx = text.indexOf(summaryCrop)
            if (cropIdx > 0) {
                console.warn("config.stop_message_when_string_is_found: CROPPING TEXT AT IDX =", cropIdx, " TEXT CROPPED =", JSON.stringify(text.slice(cropIdx, cropIdx + 20).trim()), " START OF TEXT =", JSON.stringify(text.slice(0, 20).trim()))
                text = text.slice(0, cropIdx)
            }
        }
    }
    return text
}

/**
 * Used as a callback for WebSocket to get Claude's response. Won't actually do anything until Claude stops "typing"
 * and then send it back to SillyTavern as an OpenAI chat completion result. Used when not streaming.
 * @param {*} message The WebSocket message object
 * @param {*} res The Response object for SillyTavern's request
 */
function getClaudeResponse(message, res) {
    try {
        let data = JSON.parse(message);
        if (!isMessageValid(data)) {
            if (lastMessage && lastMessage.length > 0) {
                console.warn("MESSAGE INCOMPLETE, CLAUDE SENDING FILE")
                const content = lastMessage
                lastMessage = ''
                res.json({
                    choices: [{
                        message: {
                            content: content,
                        }
                    }]
                });
            }
            return;
        }
        if (data.subtype === 'message_changed') {
            let text = data.message.text
            let stillTyping = text.endsWith(typingString);
            const textUncropped = text
            text = cropText(text)
            if (textUncropped.length > text.length) {
                stillTyping = false
                if (data.message.thread_ts) {
                    blacklisted_threads.add(data.message.thread_ts);
                    console.log("Message thread stopped early ", data.message.thread_ts, " blacklisted_threads =", blacklisted_threads)
                }
            }
            if (!stillTyping) {
                res.json({
                    choices: [{
                        message: {
                            content: text
                        }
                    }]
                });
            } else {
                // mostly just leaving this log in since there is otherwise zero feedback that something is incoming from Slack
                lastMessage = text
                console.log(`received ${text.length} characters...`);
            }
        }
    } catch (error) {
        console.error('Error parsing Slack WebSocket message:', error);
    }
}

/**
 * Simply sends [DONE] on the event stream to let SillyTavern know nothing else is coming.
 * Used both to finish the response when we're done, as well as on errors so the stream still closes neatly
 * @param {*} res - The Response object for SillyTavern's request
 */
function finishStream(res) {
    try {
        res.write('\ndata: [DONE]');
    } catch (error) {
        console.error(error)
    }
    try {
        res.end();
    } catch (error) {
        console.error(error)
    }
}

/**
 * Takes the OpenAI formatted messages send by SillyTavern and converts them into multiple plain text
 * prompt chunks. Each chunk should fit into a single Slack chat message without getting cut off.
 * Default is 12000 characters. Slack messages can fit a little more but that gives us some leeway.
 * @param {*} messages Prompt messages in OpenAI chat completion format
 * @returns An array of plain text prompt chunks
 */
function buildSlackPromptMessages(messages) {
    let prompts = [];
    let currentPrompt = '';
    for (let i = 0; i < messages.length; i++) {
        let msg = messages[i];
        let promptPart = convertToPrompt(msg, i);
        if (currentPrompt.length + promptPart.length < maxMessageLength) {
            currentPrompt += promptPart;
        } else {
            if (currentPrompt.length > 0) {
                prompts.push(currentPrompt);
            }
            // edge case where a single message is bigger than allowed
            if (promptPart.length > maxMessageLength) {
                let split = splitMessageInTwo(msg.content, maxMessageLength - messageLengthOverhead, 500)
                messages.splice(i + 1, 0, { ...msg, content: split[1], role: ""})
                promptPart = convertToPrompt({ ...msg, content: split[0] }, i);
            }
            currentPrompt = promptPart;
        }
    }
    prompts.push(currentPrompt);
    return prompts;
}

/**
 * Takes an OpenAI message and translates it into a format of "Role: Message"
 * Messages from the System role are send as is.
 * For example dialogue it takes the actual role from the 'name' property instead.
 * By default the role "user" is replaced with "Human" and the role "assistant" with "Assistant"
 * @param {*} msg 
 * @returns 
 */
function convertToPrompt(msg, idx) {
    if (config.dont_send_user_role_if_first_message && idx == 0 && (msg.role === 'system' || msg.role === 'user')) {
        return `${msg.content}\n\n`
    }
    if (msg.role === 'system') {
        if ('name' in msg) {
            return `${config.rename_roles[msg.name]}: ${msg.content}\n\n`
        }
    }
    if (config.rename_roles[msg.role]) {
        return `${config.rename_roles[msg.role]}: ${msg.content}\n\n`
    }
    return `${msg.content}\n\n`
}

/**
 * Posts a chat message to Slack, depending on the parameters
 * @param {*} msg The message text, if applicable
 * @param {*} thread_ts The Slack timestamp of the message we want to reply to
 * @param {*} pingClaude Whether to ping Claude with the message
 * @returns 
 */
async function postSlackMessage(msg, thread_ts, pingClaude) {
    var form = new FormData();
    form.append('token', config.TOKEN);
    form.append('channel', `${config.CHANNEL}`);
    form.append('_x_mode', 'online');
    form.append('_x_sonic', 'true');
    form.append('type', 'message');
    form.append('xArgs', '{}');
    form.append('unfurl', '[]');
    form.append('include_channel_perm_error', 'true');
    form.append('_x_reason', 'webapp_message_send');
    
    if (thread_ts !== null) {
        form.append('thread_ts', thread_ts);
    }

    let blocks = [{
        'type': 'rich_text',
        'elements': [{
            'type': 'rich_text_section',
            'elements': []
        }]
    }];
    if (!pingClaude) {
        blocks[0].elements[0].elements.push({
            'type': 'text',
            'text': msg
        });
    } else {
        if (config.PING_MESSAGE_PREFIX) {
            blocks[0].elements[0].elements.push({
                'type': 'text',
                'text': config.PING_MESSAGE_PREFIX
            }); 
        }
        blocks[0].elements[0].elements.push({
            'type': 'user',
            'user_id': config.CLAUDE_USER
        });
        if (config.PING_MESSAGE) {
            blocks[0].elements[0].elements.push({
                'type': 'text',
                'text': config.PING_MESSAGE
            });
        }
    }

    form.append('blocks', JSON.stringify(blocks));

    var res = await axios.post(`https://${config.TEAM_ID}.slack.com/api/chat.postMessage`, form, {
        headers: {
            'Cookie': `d=${config.COOKIE};`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0',
            ...form.getHeaders()
        }
    });

    if ("ok" in res.data && !res.data.ok) {
        if ("error" in res.data) {
            if (res.data.error === "invalid_auth" || res.data.error === "not_authed") {
                throw new Error("Failed posting message to Slack. Your TOKEN and/or COOKIE might be incorrect or expired.");
            } else {
                throw new Error(res.data.error);
            }
        } else {
            throw new Error(res.data);
        }
    }

    return res.data.ts;
}

async function createSlackThread(promptMsg) {
    return await postSlackMessage(promptMsg, null, false);
}

async function createSlackReply(promptMsg, ts) {
    return await postSlackMessage(promptMsg, ts, false);
}

async function createClaudePing(ts) {
    lastMessage = '';
    return await postSlackMessage(null, ts, true);
}