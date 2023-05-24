const config = {
    TOKEN: "xoxc-xxxx",
    COOKIE: "xoxd-xxxx",
    TEAM_ID: "workspacename",
    CHANNEL: "C1234D4567S",
    CLAUDE_USER: "U1234A568BC",

    edit_msg_with_ping: true,

    // if edit_msg_with_ping is false:
    // (i.e.send new message with ping instead of editting the first one)
    // The final message we send with an @Claude ping to trigger his response. You don't need to add the @Claude bit, Slaude does that automatically.
    // This goes just after your Jailbreak, it goes into its own "Human:" chat reply, instead of appended to the last prompt like JB
    // Can be whatever you want it to be but keep in mind that it might result in unpredictable responses.
    // Anything we put here will eat into our max available tokens so keep it brief. Anything above ~12000 characters will get cut off by Slack.
    PING_MESSAGE_PREFIX: ".\n\n�A",
    PING_MESSAGE: "r�",

    // if edit_msg_with_ping is true:
    PING_PREFIX: "�A",
    PING_SUFFIX: "r�\n\n\n",
    // You can put many tokens in these if you want, in the limit, they'll be pushed out of context
    ping_at_start_of_msg: true, // if false, the ping will be edited in to the end of your prompt+card, so it will be between it and [Start Chat]
    // The "Claude" string is necessary to trigger Claude, but it reminds Claude of who it is
    // You can muddle the string by, for example, adding 'A' to the end of the prefix, and 'r' to the start of the suffix
    // Which makes the text AClauder, which has a different token breakdown than Claude (Cla+ude -> AC+l+auder)

    // The weird � character is less supported, but the thought process was to make the thing seem like a leftover error and for the model to ignore it, "AClauder" doesn't make any sense after all. You can remove it to try it out or if you think anything weird is happening, but felt good to me.
    // Either way I strongly suggest not using ":" as it confuses it with the usual H: and A:

    // Claude specs:
    // Human, Assistant, H, A
    rename_roles: {
        'system': 'H',
        'user': 'H',
        'assistant': 'A',
        'example_user': 'H',
        'example_assistant': 'A',
    },

    minimum_split_size: 500,
    dont_send_user_role_if_first_message: true,

    stop_message_when_string_is_found: [
        "\nH: ",
        "\nHuman: ",
        "<EOT>",
    ],

    // redo the request up to this amount, if it fails
    retry_count: 5,

    // Automatically fail request if it doesn't pass the below criteria:
    // Be careful with `auto_swipe_minimum_length`, as it will not allow short messages through, set it to 0 if this is undersirable
    // 0 to disable
    auto_swipe_minimum_length: 0,
    // If enough words on the blacklist are contained in the response, auto retry
    // 0 to disable
    auto_swipe_blacklist_threshold: 2,
    auto_swipe_blacklist: [
        "ethical(ly)?",
        "unethical",
        "guidelines?",
        "harmful",
        "illegal",
        "(un)?comfortable",
        "engage",
        "generat(e|ing)",
        "nonconsensual",
        "I apologize",
        "My apologies",
        "upon further reflection",
        "continue this story",
        "(unable to|not) (continue|respond|provide|appropriate)",
        "inappropriate",
        "content",
    ],
    // wait before starting to send text, lest it be filtered
    auto_swipe_prebuffer_length: 200,

    // if edit_msg_with_ping: true
    // request multiple Claude replies
    // WARN: if you this above 5 you are fucking yourself over because:
    // * it seems like there's a limited amount of Claude responses at the same time for each workspace, so you'll have to wait for every request to finish to get your next ones
    // * requests might poison one another, if one takes too long to start, maybe
    multi_response: 1,
    // delay between edits, could possibly be lower, didn't test it
    multi_response_delay: 50,
    // edit more times if the initial `multi_response` few get filtered
    // possibly bad
    retry_count_edit: 0,
    // Slack is weird, wait a bit before editting or
    // it won't trigger Claude
    // it won't get all context
    delay_before_edit: 400,
        
    // timeout if reply is taking too long to start being received
    reply_timeout_delay: 30 * 1000,
    // timeout if waiting just for the last multi reply
    reply_multi_timeout_delay: 6 * 1000,
    // timeout if reply is message is taking too long to update more
    reply_update_timeout_delay: 10 * 1000,

    PORT: 5004,
}

export default config;