# comfyui-suggest-dt

ComfyUI のすべてのテキストエリアで Danbooru タグのオートコンプリートを提供するカスタムノードです。
旧来の LiteGraph キャンバスと新しい Nodes 2.0（Vue）フロントエンドの両方に対応しています。

[pythongosssss/ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) および [DominikDoom/a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) を参考にしています。

---

## 機能

- **Danbooru タグサジェスト** — すべての multiline テキストウィジェットで入力中にオートコンプリート
- **カテゴリ別カラーコーディング** — General / Artist / Copyright / Character / Meta を Danbooru の配色で色分け
- **エイリアス検索** — `/lh` で `long_hair` が見つかるなど、エイリアスにも対応
- **Wiki ツールチップ** — 候補の `?` ボタンをホバーすると Danbooru Wiki の内容をインラインプレビュー、クリックで該当ページを新タブで開く
- **ファイルソース** — ローカルフォルダ内の `.txt` / `.yaml` ファイル名を任意のプレフィックス・サフィックス付きでサジェスト（ワイルドカード・スタイルファイルなどに対応）
- **Nodes 2.0 対応** — DOM の `MutationObserver` を使用しているため、どちらのレンダリングシステムでも動作

---

## インストール

### ComfyUI Manager 経由
**comfyui-suggest-dt** を検索してインストール。

### 手動
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/your-username/comfyui-suggest-dt
```

ComfyUI を再起動してください。初回起動時にタグデータ（`danbooru.csv`、約10万タグ）がバックグラウンドで自動ダウンロードされます。

---

## 使い方

### Danbooru タグオートコンプリート

テキストウィジェットで **2文字以上** 入力するとカーソル付近にドロップダウンが表示され、投稿数の多い順にタグ候補が並びます。

| キー | 動作 |
|------|------|
| `↑` / `↓` | 候補を移動 |
| `Tab` または `Enter` | 選択したタグを挿入（後ろに `, ` を追加） |
| `Escape` | ドロップダウンを閉じる |

各候補の右端に `?` ボタンが表示されます：

- **ホバー** — Danbooru Wiki の内容をツールチップでプレビュー
- **クリック** — `danbooru.donmai.us/wiki_pages/{タグ名}` を新タブで開く

### ファイルソース

ローカルフォルダ内のファイル名を任意のプレフィックス・サフィックス付きでサジェストする機能です。
[comfyui-promptcraft](https://github.com/your-username/comfyui-promptcraft) などのワイルドカードシステムと組み合わせて使用できます。

**設定 → suggest-dt → Configure File Sources…** から設定ダイアログを開きます。

![ファイルソース設定ダイアログ](images/setting.png)

| 項目 | 説明 |
|------|------|
| **Folder** | `.txt` / `.yaml` / `.yml` ファイルが入ったフォルダの絶対パス |
| **Prefix** | サジェスト時にファイル名の前に付けるテキスト（例: `__`） |
| **Suffix** | 挿入時にファイル名の後ろに付けるテキスト（例: `__`） |

**例：** フォルダ `/wildcards`、プレフィックス `__`、サフィックス `__` の場合：
- `__emot` と入力 → `__emotion__`、`__emotional__`、… がサジェスト
- 選択すると `__emotion__, ` がテキストに挿入される

登録済みプレフィックスで始まる単語を入力した場合、ファイルソースの候補が **Danbooru タグより優先** されます。

---

## データについて

タグデータは [a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) の `danbooru.csv`（上位約10万タグ、形式: `name, category, count, "aliases"`）を使用しています。

ファイルは `data/danbooru.csv` にキャッシュされ、**再起動時には再ダウンロードされません**。
強制的に更新したい場合はファイルを削除して ComfyUI を再起動してください。

ファイルソースの設定は `data/file-sources.json` に保存されます。

---

## 動作環境

- ComfyUI（LiteGraph または Nodes 2.0 フロントエンド）
- Python 3.10+
- `aiohttp`（ComfyUI に同梱）
