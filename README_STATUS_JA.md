# fs-tools-mcp 現状把握 README（日本語）

このドキュメントは、**今の実装状態を読むためのスナップショット**です。  
開発手順の網羅よりも、「何が実装済みで、どこに制約があるか」を優先してまとめています。

## 1. スナップショット（2026-04-12 JST）

- リポジトリ: `@kongyo2/fs-tools-mcp`
- ブランチ: `main`
- コミット: `d18a781`
- 作業ツリー: clean（未コミット変更なし）
- Node.js: `v24.13.0`（`package.json` は `>=20`）
- TypeScript: `5.9.3`
- 主要依存:
  - `@modelcontextprotocol/sdk` `1.29.0`
  - `@vscode/ripgrep` `1.17.1`
  - `diff` `8.0.4`
  - `sharp` `0.34.5`
  - `zod` `3.25.76`

## 2. 全体構成

- エントリポイント: `src/index.ts`
  - `StdioServerTransport` で MCP サーバーを起動
- サーバー生成: `src/server.ts`
  - `createSessionState()` を作成
  - 以下5ツールを登録:
    - `fs_read`
    - `fs_edit`
    - `fs_write`
    - `fs_glob`
    - `fs_grep`
- セッション状態: `src/state.ts`
  - `readFileState: Map<string, ReadFileStateEntry>`
  - 各ファイルの最終 read 内容・mtime・offset/limit を保持
- ソース規模:
  - `src/` 配下: 33ファイル
  - `test/` 配下: 5ファイル

## 3. ツール別の現状仕様

### `fs_read`

- 目的: テキスト / 画像 / Notebook / PDF の読み込み
- 主要入力:
  - `file_path`
  - `offset` / `limit`（行単位）
  - `pages`（PDFのページ範囲、例: `"1-5"`）
- 実装上の挙動:
  - バイナリ拡張子を拒否（例外: 画像系, PDF）
  - 一部デバイスパス（`/dev/zero` など）を拒否
  - Notebook（`.ipynb`）はセル構造に展開して返す
  - 画像はトークン予算に合わせてリサイズ/圧縮
  - PDFは通常 base64 返却、`pages` 指定時はページ画像抽出
  - 直前 read と同条件で未更新なら `file_unchanged` を返す
- 制限:
  - デフォルト最大読み込みサイズ: `MAX_OUTPUT_SIZE = 0.25MB`
  - 推定最大トークン: `25,000`（環境変数で変更可）
  - PDF 1回あたり最大ページ数: `20`
  - PDF 全体読み込みの閾値（ページ数）: `10`超なら `pages` 指定要求

### `fs_edit`

- 目的: `old_string` / `new_string` で部分置換
- 主要入力:
  - `file_path`
  - `old_string`
  - `new_string`
  - `replace_all`（既定 `false`）
- 安全条件:
  - 複数一致かつ `replace_all=false` は拒否
  - `.ipynb` は編集拒否（必要なら `fs_write` の全書き換え）
- 特徴:
  - カーリークォートを含む文字列のマッチ・置換補正あり
  - 改行削除時に末尾改行を自然に処理
  - 差分（structured patch）を生成して返す
- 例外:
  - ファイル未存在かつ `old_string=""` の場合は新規作成可能

### `fs_write`

- 目的: ファイル全体の新規作成/上書き
- 安全条件:
  - 事前 `fs_read` なしでも既存ファイルを直接上書き可能
- 返却:
  - `create` / `update` 種別
  - update時は structured patch を返す
- 注意:
  - 書き込み時の改行は `LF` 固定で出力

### `fs_glob`

- 目的: globパターンで高速ファイル検索
- 実装:
  - 内部的に ripgrep `--files --glob` を利用
  - 変更時刻順（`--sort=modified`）
- 現在の固定値:
  - 返却上限 `100` 件（コード固定）
  - タイムアウト `60` 秒
- 環境変数:
  - `FS_TOOLS_MCP_GLOB_NO_IGNORE`（既定 true）
  - `FS_TOOLS_MCP_GLOB_HIDDEN`（既定 true）

### `fs_grep`

- 目的: 正規表現検索（ripgrep）
- モード:
  - `content`
  - `files_with_matches`（既定）
  - `count`
- 主要機能:
  - `glob` フィルタ、`type` フィルタ
  - `-A/-B/-C/context`
  - `-i` 大文字小文字無視
  - `multiline`
  - `head_limit` と `offset` によるページング
- 既定値:
  - `head_limit` 既定 `250`（`0`で無制限）
  - `.git/.svn/...` のVCSディレクトリは除外

## 4. 重要な制限値（定数）

- 画像:
  - API用 base64 上限: `5MB`
  - 目標生サイズ: `3.75MB`
  - 最大寸法: `2000x2000`
- PDF:
  - 通常読み込み上限: `20MB`
  - ページ抽出上限: `100MB`
  - 1回のページ抽出上限: `20ページ`
- 読み込みトークン:
  - 既定 `25,000` token 相当
  - `FS_TOOLS_MCP_FILE_READ_MAX_OUTPUT_TOKENS` で上書き可
- ripgrep タイムアウト:
  - `FS_TOOLS_MCP_GLOB_TIMEOUT_SECONDS` 未指定時:
    - WSL: 60秒
    - それ以外: 20秒

## 5. 外部依存コマンドの扱い

- ripgrep:
  - `@vscode/ripgrep` 同梱バイナリを使用
- PDF:
  - ページ数取得: `pdfinfo`
  - ページ画像抽出: `pdftoppm`
  - `pdftoppm` 未導入時は明示エラーを返す

## 6. テストの現状（2026-04-12 実行）

実行コマンド:

```bash
npm.cmd test
```

結果:

- `PASS summary: 9 tests`
- 主要確認対象:
  - `fsEditUtils`（置換・差分・クォート補正）
  - `readFileInRange`（行範囲・バイト打ち切り）
  - `glob` / `ripGrep`
  - `parsePDFPageRange`
  - `extractGlobBaseDirectory`

補足:

- `test/run.ts` が実行対象（自前ランナー）。
- `node:test` 形式のテストファイルも存在するが、`npm test` はそれらを直接実行していない。

## 7. 既知のギャップ・注意点

- パスアクセス制限:
  - 実装内で「作業ディレクトリ配下のみ許可」の強制はしていない。
  - 実行ユーザー権限で到達できる絶対パスにアクセス可能。
- `fs_edit` / `fs_write`:
  - 事前 read を強制する安全装置は実装していない。
  - 別プロセス/別ユーザー更新との競合検知（mtimeベース）も行わない。
- `fs_read` の説明文は絶対パス前提だが、実装上は `expandPath()` により相対パスも解決される。
- PDFページ数チェックは `pdfinfo` が利用できる場合のみ厳密になる。
- `fs_write` は既存ファイル更新時でも改行を `LF` で書き出す（CRLF維持ではない）。
- 永続状態は持たず、`readFileState` はプロセス内メモリのみ（再起動で消える）。

## 8. 最低限の実行コマンド

```bash
npm install
npm run build
npm run dev
npm.cmd test
```

`dev` は `tsx src/index.ts` で stdio MCP サーバーを起動します。
