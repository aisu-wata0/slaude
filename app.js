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

function console_log(...args) {
    const currentDate = new Date();
    const milliseconds = currentDate.getMilliseconds().toString().padStart(3, '0');
    const formattedDate = `${currentDate.toISOString().split("T")[0]} ${currentDate.toTimeString().split(" ")[0]}.${milliseconds}`;

    console.log(`[${formattedDate}]`, ...args);
}
function waitTimout(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}


function containsBlacklistedWords(str, blacklist, threshold) {
    const regex = new RegExp(`\\b(${blacklist.join('|')})\\b`, 'gi');
    const matches = str.match(regex) || [];
    return matches.length >= threshold;
}

const generatedTextFiltered = (text, finished) => {
    if (text) {
        if (finished) {
            if (config.auto_swipe_minimum_length) {
                if (text.length < config.auto_swipe_minimum_length && text.length !== 0) {
                    console.log("Generated text size too small")
                    return true
                }
            }
        }
        if (config.auto_swipe_blacklist_threshold) {
            if (containsBlacklistedWords(text, config.auto_swipe_blacklist, config.auto_swipe_blacklist_threshold)) {
                console.log("Generated text has blacklisted words")
                return true
            }
        }
    }
    return false
}

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
        let streamQueue = Promise.resolve();

        let stream = req.body.stream ?? false;
        let promptMessages = buildSlackPromptMessages(req.body.messages);

        let threadTs = await createSlackThread(promptMessages[0]);

        if (threadTs === null || threadTs === undefined) {
            throw new Error("First message did not return a thread timestamp. Make sure that CHANNEL is set to a channel ID that both your Slack user and Claude have access to.")
        }

        let thread = {
            ts: threadTs,
            lastMessage: "",
            promptMessages,
        }
        console_log(`Created thread with ts ${thread.ts}`);

        if (promptMessages.length > 1) {
            for (let i = 1; i < promptMessages.length; i++) {
                await createSlackReply(promptMessages[i], thread.ts);
                console_log(`Created ${i}. reply on thread ${thread.ts}`);
            }
        }

        let ws = await openWebSocketConnection(res);

        if (stream) {
            console_log("Opened stream for Claude's response.");
            streamQueue = Promise.resolve();
            ws.on("message", (message) => {
                streamQueue = streamQueue.then(streamNextClaudeResponseChunk.bind(this, message, res, thread));
            });
        } else {
            console_log("Awaiting Claude's response.");
            ws.on("message", (message) => {
                getClaudeResponse(message, res, thread);
            });
            if (config.reply_timeout_delay) {
                thread.timeout = setTimeout(() => {
                    console_log("Response taking too long, ending.")
                    try {
                        res.end();
                    } catch (error) {
                        console.error(error)
                    }
                }, config.reply_timeout_delay);
            }
        }
        ws.on("error", (err) => {
            console.error(err);
        });
        ws.on("close", (code, reason) => {
            console_log(`Closed socket on thread ${thread.ts}`)
        });

        res.on("finish", () => {
            ws.close();
            console_log("Finished returning Claude's response.");
            if (thread.timeout) {
                clearTimeout(thread.timeout);
            }
        });

        if (config.edit_msg_with_ping) {
            // if you don't wait, there's a chance Slack triggers Claude twice
            for (let i = 0; i < config.multi_response; i++){
                await claudePingEdit(thread.promptMessages[0], thread.ts);
                await waitTimout(config.multi_response_delay)
            }
        } else {
            await createClaudePing(thread.ts);
            console_log(`Created Claude ping on thread ${thread.ts}`);
        }
    } catch (error) {
        console.error(error);
        next(error);
    }
});

app.listen(config.PORT, () => {
    console_log(`Slaude is running at http://localhost:${config.PORT}`);
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

    if (!config.multi_response) {
        config.multi_response = 1
    }
    Math.max(1, config.multi_response)
    if (!config.multi_response_delay) {
        config.multi_response_delay = 100
    }
    Math.max(10, config.multi_response_delay)
}

/** Opens a WebSocket connection to Slack with an awaitable Promise */
function openWebSocketConnection(res) {
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
            try {
                res.end();
            } catch (error) {
            }
            if (code !== 1000 && code !== 1005) {
                console.error(`WebSocket connection closed abnormally with code ${code} and reason ${reason}. Your cookie and/or token might be incorrect or expired.`)
            }
        })
    });
}

/** 
 * Hacky bullshit that compares the last message we got from Slack with the current one and returns the difference.
 * Only needed for streaming.
 */
function getNextChunk(text, thread) {
    // Current and last message are identical, can skip streaming a chunk.
    if (text === thread.lastMessage) {
        return '';
    }

    // if the next message doesn't have the entire previous message in it we received something out of order and dismissing it is the safest option
    if (!text.includes(thread.lastMessage)) {
        return '';
        // thread.lastMessage = text
        // return text;
    }

    let chunk = text.slice(thread.lastMessage.length, text.length);
    thread.lastMessage = text;
    return chunk;
}

/** Strips the "Typing..." string from the end of Claude's messages. */
function stripTyping(text) {
    return text.slice(0, text.length-typingString.length);
}

function isMessageValid(data, thread) {
    if (isMessageFile(data)) {
        console_log("isMessageFile")
        return false
    }
    if (!data.message) {
        return true
    }
    let senderID = data.user;
    if (!senderID) {
        if (data.message.user) {
            senderID = data.message.user
        }
    }
    if (senderID && senderID !== config.CLAUDE_USER) {
        // if not from Claude
        // console_log("Message from socket not from Claude but from ID =", senderID, JSON.stringify(data.message.text.slice(0, 55).trim()))
        return false;
    }
    if (!isMessageFromThread(data, thread)) {
        console_log("!isMessageFromThread(data, thread)")
        return false;
    }
    return true;
}

function isMessageFile(data) {
    return data.subtype === 'file_share' || data.type === 'file_created' || data.type === 'file_shared'
}

function isMessageFromThread(data, thread) {
    if (!data.message || !data.message.ts) {
        // console_log("!data.message || !data.message.ts")
        return false
    }
    if (isMessageBlacklisted(data, thread)) {
        return false
    }
    if (!data.message.thread_ts || !(data.message.thread_ts === thread.ts)) {
        console_log("Intended: Ignoring Claude sending message in other thread ", data.message.thread_ts, " current thread =", thread.ts)
        console_log(JSON.stringify(data.message.text.slice(0, 55).trim()))
        return false
    }
    return true;
}

function isMessageBlacklisted(data, thread) {
    if (thread.ClaudeTsBlacklist) {
        if (!data.message.ts || thread.ClaudeTsBlacklist.has(data.message.ts)) {
            console_log("Intended: Ignoring Claude's old message ", data.message.ts)
            console_log(JSON.stringify(data.message.text.slice(0, 55).trim()))
            return true
        }
    }
    return false
}

/** 
 * Used as a callback for WebSocket to get the next chunk of the response Claude is currently typing and
 * write it into the response for SillyTavern. Used for streaming.
 * @param {*} message The WebSocket message object
 * @param {*} res The Response object for SillyTavern's request
 */
function streamNextClaudeResponseChunk(message, res, thread) {
    return new Promise((resolve, reject) => {
        try {
            let data = JSON.parse(message);
            // if (thread.ClaudeTsSet) {
            //     if (thread.ClaudeTsSet.size > 0) {
            //         console_log("thread.ClaudeTsSet      ", thread.ClaudeTsSet)
            //     }
            // }
            if (!isMessageFromThread(data, thread)) {
                resolve();
                return;
            }
            if (isMessageFile(data)) {
                if (thread.lastMessage && thread.lastMessage.length > 0) {
                    console.warn("MESSAGE INCOMPLETE, CLAUDE SENDING FILE")
                    finishStreamTimeout(res, thread);
                }
                resolve();
                return;
            }
            if (!isMessageValid(data, thread)) {
                resolve();
                return;
            }
            if (data.subtype === 'message_changed') {
                if (thread.finishTimeout) {
                    console_log("thread.finishTimeout cleared")
                    clearTimeout(thread.finishTimeout);
                    thread.finishTimeout = null;
                }
                if (thread.timeout) {
                    clearTimeout(thread.timeout);
                    if (config.reply_timeout_delay) {
                        thread.timeout = setTimeout(() => {
                            console_log("Streaming response taking too long, closing stream.")
                            finishStream(res);
                        }, config.reply_timeout_delay);
                    }
                }
                if (!thread.ClaudeTsSet) {
                    thread.ClaudeTsSet = new Set();
                }
                thread.ClaudeTsSet.add(data.message.ts)

                let text = data.message.text;
                let stillTyping = text.endsWith(typingString);
                text = stillTyping ? stripTyping(text) : text;
                const textUncropped = text
                text = cropText(text)
                if (textUncropped.length > text.length) {
                    stillTyping = false
                    if (data.message.thread_ts) {
                        // blacklisted_threads.add(data.message.thread_ts);
                        console_log("Message thread stopped early ", data.message.thread_ts)
                    }
                }

                if (thread.lastMessageTs && thread.lastMessageTs !== data.message.ts) {
                    resolve();
                    return;
                }
                if (text.length <= config.auto_swipe_prebuffer_length) {
                    console_log(`Checking message ${data.message.ts}`)
                    if (generatedTextFiltered(text, !stillTyping)) {
                        console_log(`Filtered message  ${data.message.ts}, retrying...`)
                        if (!thread.ClaudeTsBlacklist) {
                            thread.ClaudeTsBlacklist = new Set();
                        }
                        thread.ClaudeTsBlacklist.add(data.message.ts)
                        thread.ClaudeTsSet.delete(data.message.ts)
                        if (!thread.totalMessagesCount) {
                            thread.totalMessagesCount = 0;
                        }
                        thread.totalMessagesCount++;
                        claudePingEdit(thread.promptMessages[0], thread.ts);
                        resolve();
                        return;
                    }
                    if (stillTyping) {
                        resolve();
                        return;
                    }
                }
                if (thread.lastMessageTs && thread.lastMessageTs !== data.message.ts) {
                    resolve();
                    return;
                }
                // passed filters, use get just this response
                if (!thread.lastMessageTs) {
                    if (!thread.totalMessagesCount) {
                        thread.totalMessagesCount = 0;
                    }
                    thread.totalMessagesCount += thread.ClaudeTsSet.size - 1
                    if (!thread.ClaudeTsBlacklist) {
                        thread.ClaudeTsBlacklist = new Set();
                    }
                    thread.ClaudeTsBlacklist = new Set([...thread.ClaudeTsSet, ...thread.ClaudeTsBlacklist]);
                    thread.ClaudeTsBlacklist.delete(data.message.ts)
                    thread.ClaudeTsSet = new Set([data.message.ts]);
                    thread.lastMessageTs = data.message.ts
                    console_log(`Passed filters: ${data.message.ts}`)
                }

                let chunk = getNextChunk(text, thread);

                if (chunk.length === 0 && stillTyping) {
                    resolve();
                    return;
                }
                console_log(`Got ${chunk.length} characters from thread ${thread.ts}; post ${data.message.ts}; ${chunk}`)
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
                    console_log(`totalMessagesCount = ${thread.totalMessagesCount}`)
                    finishStreamTimeout(res, thread);
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
 * @param {*} thread The thread object with ts and lastMessage
 */
function getClaudeResponse(message, res, thread) {
    try {
        let data = JSON.parse(message);
        if (!isMessageFromThread(data, thread)) {
            return;
        }
        if (!isMessageValid(data, thread)) {
            if (thread.lastMessage && thread.lastMessage.length > 0) {
                console.warn("MESSAGE INCOMPLETE, CLAUDE SENDING FILE")
                res.json({
                    choices: [{
                        message: {
                            content: thread.lastMessage,
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
                    // blacklisted_threads.add(data.message.thread_ts);
                    console_log("Message thread stopped early ", data.message.thread_ts)
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
                thread.lastMessage = text
                console_log(`received ${text.length} characters...`);
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

function finishStreamTimeout(res, thread, delay = 0) {
    if (delay) {
        console_log("Timeout set")
        thread.finishTimeout = setTimeout(() => {
            finishStream(res);
        }, delay);
    } else {
        finishStream(res);
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
async function postSlackMessage(msg, thread_ts, pingClaude, edit_msg_ts = null) {
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
    if (edit_msg_ts) {
        form.append('ts', edit_msg_ts);
    }
    
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
        blocks[0].elements[0].elements.push({
            'type': 'text',
            'text': `${config.PING_MESSAGE_PREFIX}<@${config.CLAUDE_USER}>${config.PING_MESSAGE}`
        });
    }

    form.append('blocks', JSON.stringify(blocks));
    var posturl = `https://${config.TEAM_ID}.slack.com/api/chat.postMessage`
    if (edit_msg_ts) {
        posturl = `https://${config.TEAM_ID}.slack.com/api/chat.update`
    }
    var res = await axios.post(posturl, form, {
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

async function claudePingEdit(promptMsg, threadTs) {
    const ping = `${config.PING_PREFIX}<@${config.CLAUDE_USER}>${config.PING_SUFFIX}`
    var msg_with_ping = "";
    if (config.ping_at_start_of_msg) {
        msg_with_ping = ping + "\n" + promptMsg
    } else {
        msg_with_ping = promptMsg + "\n" + ping
    }
    await postSlackMessage(msg_with_ping, null, false, threadTs);
    console_log(`Added Claude ping on thread ${threadTs}`);
}

async function createClaudePing(ts) {
    return await postSlackMessage(null, ts, true);
}