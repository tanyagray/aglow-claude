# Aglow Claude Marketplace

A plugin marketplace for Claude Code.

## Usage

Add this marketplace to Claude Code:

```bash
/plugin marketplace add tanyagray/aglow-claude
```

Then install any plugin:

```bash
/plugin install <plugin-name>@aglow
```

## Plugins

<!-- Plugins will be listed here as they are added -->

## Development

To add a new plugin, create a directory under `plugins/` with the following structure:

```
plugins/
  my-plugin/
    .claude-plugin/
      plugin.json      # Plugin manifest
    skills/            # Optional: skill definitions
    commands/          # Optional: custom commands
    hooks/             # Optional: hook configuration
    agents/            # Optional: agent definitions
    .mcp.json          # Optional: MCP server config
```
