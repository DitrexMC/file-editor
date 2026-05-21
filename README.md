# File Editor

> [!WARNING]
> **このプロジェクトは AI によって生成されたコードをベースにしています。**

複数ユーザーでファイルをリアルタイム共同編集できる Web ベースのファイルエディター。
Minecraft サーバーの設定ファイル（`.properties`、`.yml`、`.json` 等）をブラウザから直接編集する用途に最適化されています。

---

## 機能

- **Web ブラウザベース** — (ユーザー側は) インストール不要、ブラウザですぐに編集
- **リアルタイム共同編集** — Socket.IO による複数ユーザー同時編集対応
- **コンフリクト検出** — 編集中に他ユーザーが保存した場合に通知
- **ファイル一覧 / 管理** — 作成、編集、リネーム、削除、ダウンロード
- **アクティビティログ** — 誰がいつ編集したかリアルタイム表示
- **ハッシュベース変更検知** — SHA-256 でファイル内容の変更を高速検出
- **REST API** — サーバーからのファイル取得・ダウンロードに対応

---

## 導入方法

### 必要条件

- Node.js 18.0.0 以上

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/DitrexMC/file-editor
cd file-editor

# 依存パッケージをインストール
npm install

# 起動
npm start
```

デフォルトでは `http://localhost:8080` で起動します。

### ポートの指定

環境変数 `PORT` でポートを変更できます。

```bash
PORT=8080 npm start
```

指定したポートが使用中の場合は、自動的に次のポートを試行します（最大 10 回）。

---

## 使い方

### 1. ファイル一覧

トップページに `storage/` ディレクトリ内のファイル一覧が表示されます。

- **ファイルを開く** — ファイル名をクリックしてエディターを開く
- **新規ファイル作成** — 「+ New」ボタンから新規ファイルを作成
- **ダウンロード** — ⬇ ボタンでファイルをダウンロード
- **削除** — 🗑 ボタンでファイルを削除

### 2. ファイル編集

エディターページでファイルの内容を編集できます。

1. 画面下部のテキストボックスに自分の名前を入力
2. コードエリアで編集
3. **Apply** ボタン（または `Ctrl+S` / `Cmd+S` / `Ctrl+Enter`）で保存

### 3. リアルタイム共同編集

同じファイルを開いている他のユーザーの編集がリアルタイムで反映されます。
左サイドバーには編集履歴が表示され、競合発生時には最後に適用したデータが優先されます。

---

## API

### ファイル一覧を取得

```
GET /api/files
```

レスポンス:
```json
[
  {
    "name": "server.properties",
    "hash": "abc123...",
    "editor": "user1",
    "modified": "2025-01-01T00:00:00.000Z"
  }
]
```

### ファイル内容を取得

```
GET /api/files/:name
```

レスポンス:
```json
{
  "name": "server.properties",
  "content": "...",
  "hash": "abc123...",
  "editor": "user1",
  "modified": "2025-01-01T00:00:00.000Z"
}
```

### ファイルを作成

```
POST /api/files
Content-Type: application/json

{ "name": "newfile.properties" }
```

レスポンス:
```json
{
  "success": true,
  "name": "newfile.properties"
}
```

### ファイルを編集 / 保存

```
POST /api/files/:name
Content-Type: application/json

{
  "content": "ファイル内容...",
  "editor": "ユーザー名",
  "expectedHash": "編集前のハッシュ値"
}
```

`expectedHash` は競合検出に使用されます（情報目的。実際の保存は常に行われます、最終編集者優先）。

レスポンス:
```json
{
  "success": true,
  "hash": "def456...",
  "modified": "2025-01-01T00:00:00.000Z",
  "conflict": false
}
```

### ファイルをダウンロード

```
GET /api/files/:name/download
```

ファイルがダウンロードレスポンスとして送信されます。

### ファイルのハッシュを取得（高速）

```
GET /api/hash/:name
```

メモリ上のキャッシュから O(1) でハッシュを返します。Minecraft サーバー側の高頻度ポーリングに最適。

レスポンス:
```json
{
  "fileName": "server.properties",
  "hash": "abc123...",
  "editor": "user1",
  "modified": "2025-01-01T00:00:00.000Z"
}
```

### ファイルをリネーム

```
PUT /api/files/:name
Content-Type: application/json

{ "newName": "renamed.properties" }
```

レスポンス:
```json
{
  "success": true,
  "name": "renamed.properties"
}
```

### ファイルを削除

```
DELETE /api/files/:name
```

レスポンス:
```json
{
  "success": true
}
```

### アクティビティログを取得

```
GET /api/log
```

レスポンス:
```json
[
  {
    "fileName": "server.properties",
    "editor": "user1",
    "timestamp": "2025-01-01T00:00:00.000Z",
    "hash": "abc123...",
    "conflict": false,
    "overwrittenEditor": ""
  }
]
```

---

## 技術スタック

- **バックエンド**: Node.js, Express, Socket.IO
- **フロントエンド**: CodeMirror, Socket.IO Client
- **テンプレート**: EJS
- **変更検知**: SHA-256

---

## 注意事項

- ラストライターウィン方式（最終編集者優先）のため、同時編集時の競合解決は完全ではありません。重要なファイルの編集前にはバックアップを推奨します。
- 認証・認可機構を備えていないため、ネットワーク上に公開する場合はリバースプロキシ等によるアクセス制限を併用してください。

---

## ライセンス

MIT
