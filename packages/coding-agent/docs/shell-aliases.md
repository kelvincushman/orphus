# Shell Aliases

Orphus runs bash in non-interactive mode (`bash -c`), which doesn't expand aliases by default.

To enable your shell aliases, add to `~/.orphus/agent/settings.json` (legacy `~/.atomic/agent/settings.json` and `~/.pi/agent/settings.json` are also read):

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

Adjust the path (`~/.zshrc`, `~/.bashrc`, etc.) to match your shell config.
