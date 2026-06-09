# NEMSCAN

NEM (NIS1) ブロックチェーンエクスプローラーです。ブロック・トランザクション・アカウント・ネームスペース・モザイク等をブラウザから閲覧できます。

## 特徴

- ブロック・トランザクション・アカウントのリアルタイム閲覧
- ネームスペース・モザイクの一覧と詳細ページ（Create Time 表示含む）
- XEM 価格表示（外部 API 連携）
- アクティブ スーパーノード一覧
- リッチリスト（上位保有アドレス）
- ライトテーマ / ダムテーマ / ダークテーマ切り替え
- nemtool.com の歴史的アーカイブをローカルにキャッシュ（ネームスペース・モザイク・ポール）

## 必要環境

- Node.js v22 以上（`node:sqlite` 組み込みモジュールを使用）
- インターネット接続（NEM ノードおよび nemtool.com へのアクセス）

## セットアップ

```bash
git clone https://github.com/curupo/nemscan.git
cd nemscan
npm install
node index.js
```

起動後、ブラウザで http://localhost:3000/ を開いてください。

起動直後はバックグラウンドでキャッシュの初期構築が走ります（3 秒後に開始）。  
ネームスペース・モザイクのアーカイブインポートは初回のみ実行され、完了までしばらくかかります。

## データの初期化・再同期

### キャッシュ DB をすべて削除して最初からやり直す

```bash
rm cache.db cache.db-shm cache.db-wal
node index.js
```

DB ファイルを削除して再起動すると、テーブル作成とアーカイブインポートがすべて最初から実行されます。

### アーカイブを個別に再インポートする

サーバーを停止した状態で、SQLite CLI を使って該当フラグを削除してから再起動します。

```bash
# ネームスペース アーカイブを再インポート
sqlite3 cache.db "DELETE FROM cache_meta WHERE key = 'namespaces_archive_imported';"

# モザイク アーカイブを再インポート（Create Time 等の新項目が追加された場合も同様）
sqlite3 cache.db "DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported';"

# ポール アーカイブを再インポート
sqlite3 cache.db "DELETE FROM cache_meta WHERE key = 'polls_imported';"

node index.js
```

### ライブキャッシュ（ネームスペース・モザイク・リッチリスト）は自動更新

以下のデータはサーバー稼働中に自動的に定期更新されます。手動操作は不要です。

| データ | 更新間隔 |
|---|---|
| ネームスペース（ライブ） | 10 分 |
| モザイク（ライブ） | 10 分 |
| XEM 価格 | 1 分 |
| リッチリスト（ライブ） | 5 分 |
| スーパーノード一覧 | 5 分 |

## ポート変更

デフォルトは `3000` です。変更する場合は `index.js` 冒頭の `PORT` 定数を編集してください。

```js
const PORT = 3000;
```
