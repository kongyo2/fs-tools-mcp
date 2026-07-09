# fs-tools-mcp

ローカルファイルを扱うためのMCPサーバーです。
`fs_read`、`fs_edit`、`fs_write`、`fs_glob`、`fs_grep` を提供します。

## 提供ツール

| ツール     | 説明                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `fs_read`  | ファイルの読み取り。テキスト(デフォルト2000行)のほか、画像・Jupyterノートブック・PDFにも対応。        |
| `fs_edit`  | `old_string`/`new_string` 置換によるファイル編集。エンコーディングと改行コード(CRLF/LF)を保持します。 |
| `fs_write` | ファイルの新規作成・上書き。既存ファイルのエンコーディングと改行コードを保持します。                  |
| `fs_glob`  | globパターンによるファイル検索。更新日時の新しい順に返します(`limit`/`offset` でページング可能)。     |
| `fs_grep`  | ripgrepベースの正規表現検索。`content`/`files_with_matches`/`count` の出力モードに対応。              |

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

## 動作要件

- Node.js 20 以上
- PDFのページ画像化(`fs_read` の `pages` パラメータ)には `poppler-utils`(`pdftoppm`/`pdfinfo`)が必要です。

## 環境変数

| 変数                                       | 既定値 | 説明                                                                             |
| ------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| `FS_TOOLS_MCP_FILE_READ_MAX_OUTPUT_TOKENS` | 25000  | `fs_read` が1回で返す最大トークン数(概算)。                                      |
| `FS_TOOLS_MCP_RG_TIMEOUT_SECONDS`          | 20     | ripgrep実行のタイムアウト秒数(旧名 `FS_TOOLS_MCP_GLOB_TIMEOUT_SECONDS` も有効)。 |
| `FS_TOOLS_MCP_GLOB_NO_IGNORE`              | true   | `false` にすると `fs_glob` が `.gitignore` 等を尊重します。                      |
| `FS_TOOLS_MCP_GLOB_HIDDEN`                 | true   | `false` にすると `fs_glob` が隠しファイルを除外します。                          |

## 開発

```bash
npm install
npm run check   # typecheck + test + format:check + lint
npm test        # ビルドしてテストを実行
npm run dev     # tsx でサーバーを起動
```
