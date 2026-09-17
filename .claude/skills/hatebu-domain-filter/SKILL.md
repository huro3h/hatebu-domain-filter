---
name: hatebu-domain-filter
description: はてなブックマーク(b.hatena.ne.jp)の記事一覧から登録ドメインを非表示にするChrome拡張。はてブ側のDOM構造、カードの特定方法、ドメイン正規化、E2Eテストの動かし方を扱う。この拡張を修正・デバッグするとき、またははてブのマークアップ変更で非表示が効かなくなったときに使う。
---

# hatebu-domain-filter 開発メモ

MV3・ビルド不要のプレーンJS。`src/lib/domainStore.js` を設定画面・content script・
Service Worker の3か所から素の `<script>` / `importScripts` で共有している(`self.DomainStore`)。

## はてブ側のDOM(ここが本体)

記事カードのマークアップは**ページによって2種類**ある。

| ページ | 外側 | 内側 |
| --- | --- | --- |
| トップ / hotentry / entrylist / カテゴリ / site | `li.entrylist-image-entry`(+ `cat-*`) | `div.entrylist-contents` |
| 検索結果 (`/search/text?q=`) | `li.bookmark-item` | `div.centerarticle-entry` |

**2つのレイアウトに共通する唯一の手がかりが `/site/<ホスト>/` へのリンク**
(「『example.com』の新着エントリー」)。だからカード判定は
「カードのclassを探す」ではなく「`a[href^="/site/"]` を探して `closest()` で祖先カードへ遡る」
という向きで実装している。はてブがカードのclassを変えてもドメインリンクが残る限り動く。

遡り先は `OUTER_CARD_SELECTOR`(外側の `li`)を優先し、無ければ `INNER_CARD_SELECTOR`。
`closest()` は最も近い祖先を返すので、素直に書くと内側の `div` にヒットして
**空の `li` が余白と区切り線だけ残る**。優先順位はこのためにある。

### 落とし穴

- `li.entrylist-image-entry` は**広告プレースホルダ** `li.river-placement` にも付いている
  (中身は空で最後まで不可視)。テストで `waitForSelector('li.entrylist-image-entry')` すると
  これにマッチして永遠に visible にならない → `:not(.river-placement)` が必要。
  拡張本体は `/site/` リンク起点なのでプレースホルダには触れない。
- ドメインリンクの**表示テキストはホストとは限らない**(ユーザーごとにパスを持つ
  ブログサービスでは `example.com/<ユーザー名>` のようにパス付きで表示される)。
  href の1セグメント目だけを取るのが正しく、表示テキストを信用してはいけない。
- `/site/<ホスト>/` ページは**意図的に非表示処理をスキップ**している
  (`filteringAllowedHere`)。そのドメインの一覧を自分で開いたページなので、
  適用すると真っ白になって壊れて見える。ボタンからの登録だけは有効のまま。

## 非表示と描画

- `content.css` の `.hdf-hidden { display: none !important }` を
  `run_at: document_start` で読み込み、同じく document_start で起動した
  MutationObserver が**パースされた端からカードを消す**。
  一覧は全てサーバーサイドレンダリングなので、`chrome.storage` の非同期読み取りが
  済む頃にはまだ本文をパース中で、実用上ちらつかない。
- 無限スクロールの追加分も同じ MutationObserver で拾う。
- `chrome.storage.onChanged` で再評価し、**削除したドメインはリロードなしで再表示**される
  (`applyAll()` が `.hdf-card` を全部 toggle し直す)。

## 「非表示」ボタン

- カードごとに最初から差し込むと hotentry で50個以上のDOMを作ることになるので、
  `document` への1本の `mouseover` 委譲でホバーされたカードにだけ遅延生成する。
- 挿入位置はドメインリンクの直後(`insertAdjacentElement('afterend')`)。
  **カード右上に絶対配置しない**: はてブ側が `.entrylist-contents` に独自の
  position/絶対配置要素(あとで読むボタン)を持っていて競合するうえ、
  ドメイン名の真横にある方が「何が登録されるのか」が明確。
- `opacity: 0` で隠して `display: none` にしないのは、出現時にメタ行が
  リフローして記事が動くのを避けるため。
- カードにクリックハンドラがある箇所があるので、ボタンの click では
  `preventDefault()` + `stopPropagation()` が必須。

## ドメインの正規化とマッチング

`DomainStore.normalizeDomain()` が入力を `new URL()` に通してホスト名だけを取り出す
(スキーム有無どちらもOK、末尾ドットを除去、ラベルが1つだけのものは拒否)。

- **マッチは完全一致のみ**。`example.com` を登録しても `news.example.com` は消えない
  (ユーザーの明示的な選択。変更する場合はREADMEの仕様メモも直すこと)。
- IDNは `URL` がpunycodeにするが、はてブの `/site/` リンクもpunycodeなので両者は一致する。
- 表示テキストではなく href 由来のホストで比較しているので、上記 note.com のようなケースでも
  ドメイン単位で正しく揃う。

## テスト

`test/e2e.js`(Playwright + **Brave Browser Nightly**)。実サイトを叩く。
はてブのマークアップ変更を検知するのが目的なので、あえてフィクスチャを使っていない。

```sh
cd <scratch> && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
NODE_PATH=<scratch>/node_modules node test/e2e.js
```

通常のリリース版Chromeは `--load-extension` を無視するので、未パッケージ拡張の
自動テストにはBrave Nightly(またはChrome for Testing)が必要。
設定画面のトグルは `input` を `opacity:0` で隠して `.switch-track` を見せているため、
Playwrightからは `check()/uncheck()` ではなく `.switch-track` をクリックする。

## バージョニング

`CHANGELOG.md`(Keep a Changelog + SemVer)。リリース時に `[Unreleased]` を繰り上げ、
`manifest.json` の `version` を同じ番号にしてから注釈付きタグ(`v` なしの数字のみ)を打つ。
