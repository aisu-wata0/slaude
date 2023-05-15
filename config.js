const config = {
    TOKEN: "xoxc-xxxx",
    COOKIE: "xoxd-xxxx",
    TEAM_ID: "workspacename",
    CHANNEL: "C1234D4567S",
    CLAUDE_USER: "U1234A568BC",

    // The final message we send with an @Claude ping to trigger his response. You don't need to add the @Claude bit, Slaude does that automatically.
    // Can be whatever you want it to be but keep in mind that it might result in unpredictable responses.
    // Anything we put here will eat into our max available tokens so keep it brief. Anything above ~12000 characters will get cut off by Slack.
    PING_MESSAGE_PREFIX: ".\n\n�",
    PING_MESSAGE: "r�",
    minimum_split_size: 500,

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