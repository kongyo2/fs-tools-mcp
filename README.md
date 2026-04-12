# fs-tools-mcp

ローカルファイルを扱うためのMCPサーバーです。  
`fs_read`、`fs_edit`、`fs_write`、`fs_glob`、`fs_grep` を提供します。

## MCP設定例

```json
{
  "mcpServers": {
    "fs-tools": {
      "command": "npx",
      "args": ["-y", "@kongyo2/fs-tools-mcp"]
    }
  }
}
```
