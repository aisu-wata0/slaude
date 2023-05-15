const config = {
    TOKEN: "xoxc-xxxx",
    COOKIE: "xoxd-xxxx",
    TEAM_ID: "workspacename",
    CHANNEL: "C1234D4567S",
    CLAUDE_USER: "U1234A568BC",

    // The final message we send with an @Claude ping to trigger his response. You don't need to add the @Claude bit, Slaude does that automatically.
    // This goes just after your Jailbreak, it goes into its own "Human:" chat reply, instead of appended to the last prompt like JB
    // Can be whatever you want it to be but keep in mind that it might result in unpredictable responses.
    // Anything we put here will eat into our max available tokens so keep it brief. Anything above ~12000 characters will get cut off by Slack.
    PING_MESSAGE_PREFIX: ".\n\n�A",
    PING_MESSAGE: "r�",
    minimum_split_size: 500,
    // The "Claude" string is necessary for the ping as said above, but it reminds Claude of who it is
    // You can muddle that by, for example, adding 'A' to the end of the prefix, and 'r' to the start of the suffix
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
        'example_assistant': 'A'
    },

    dont_send_user_role_if_first_message: true,

    stop_message_when_string_is_found: [
        "\nH: ",
        "\nHuman: ",
    ],

    PORT: 5004,
}

export default config;