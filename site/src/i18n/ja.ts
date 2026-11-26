import type { SiteMessages } from "./en";

const ja: SiteMessages = {
  skip: "本文へスキップ",
  brandHome: "Casthop ホーム",
  navMain: "メイン",
  navDocs: "ドキュメント",
  navGithub: "GitHub",
  navGetStarted: "始める",
  navMenu: "メニュー",
  language: "言語",

  metaTitle: "Casthop — ブラウザで動くオープンソースのライブスタジオ",
  metaDescription:
    "ブラウザで動くオープンソースのライブスタジオ。ゲストはリンクから参加、ステージは最大6人。合成映像を複数の RTMP 先へ同時配信し、録画も残します。",

  heroEyebrow: "オープンソース · AGPL-3.0",
  heroTitle: "ブラウザのタブから、どこへでも同時にライブ配信。",
  heroLede:
    "Casthop は自分で運用するライブスタジオです。リンクでゲストを呼び、最大6人をステージに乗せ、1本の合成映像を YouTube、LinkedIn、X へ送ります。",
  heroRepo: "リポジトリを開く",
  heroDocs: "ドキュメントを読む",
  heroAlt:
    "Casthop のホストスタジオ。暗いブースに2人のステージ、控室のゲスト、白いライブ配信ボタン。",

  featuresTitle: "いまできること",
  feature1Title: "1回のエンコードで、複数の配信先へ。",
  feature1Body:
    "Casthop は合成映像を YouTube、LinkedIn、X へ RTMP で同時に送ります。LiveKit Egress が一度トランスコードして各 URL に配り、録画も残します。",
  feature1Link: "配信先のしくみ",
  feature2Title: "ゲストはリンクから参加。",
  feature2Body:
    "ゲストリンクを送るだけ。アカウントもインストールも不要です。控室で待ち、あなたがステージに上げます。同時に最大6人。ホスト側はログインが必要です。",
  feature2Link: "ゲスト",
  feature3Title: "背景ぼかしは、ブラウザの中で。",
  feature3Body:
    "カメラのぼかしは端末上で MediaPipe の Selfie Segmenter が処理します。モデルはぼかしをオンにしたときだけ、自分のオリジンから読み込みます。CDN は使いません。",
  feature3Link: "アーキテクチャ",
  feature4Title: "配信は、落ちても自分で戻る。",
  feature4Body:
    "Egress やストリームが落ちると、スタジオはバックオフ付きで再試行します。配信先ごとに RTMP の状態が出るので、どれが止まったか分かります。",
  feature4Link: "配信先ごとの状態",

  ossEyebrow: "セルフホスト",
  ossTitle: "メディアプレーンは、あなたが動かす。",
  ossP1:
    "LiveKit、Egress、Redis、RTMP エッジは Docker で、自分のマシンかサーバー上で動かします。コントロールプレーンは Durable Objects と D1 付きの Cloudflare Worker です。ストリームキーは Durable Object に留まり、ゲストには返りません。",
  ossP2:
    "サーバーは AGPL-3.0-only なので、ホストするフォークは変更を公開する必要があります。動くプロトタイプです。核を確かめ、測ってから磨いてください。角は残っています。数字はリポジトリの計測を見てください。",
  ossGithub: "GitHub で見る",
  ossDocs: "セルフホストのドキュメント",

  footerTagline: "ブラウザで動くオープンソースのライブスタジオ。",
  footerDocs: "ドキュメント",
  footerGettingStarted: "はじめに",
  footerSelfHosting: "セルフホスト",
  footerConfiguration: "設定",
  footerArchitecture: "アーキテクチャ",
  footerProject: "プロジェクト",
  footerLicense: "Casthop は AGPL-3.0-only でライセンスされています。",

  docsChromeTitle: "Casthop ドキュメント",
  docsChromeDescription: "Casthop のドキュメント。",
  docsTitleSuffix: "Casthop ドキュメント",
  docsNav: "ドキュメント",
  docsSections: "セクション",
  searchDocs: "ドキュメントを検索",
  searchHint: "Esc で閉じる · ↑ ↓ で移動 · Enter で開く",
  searchEmpty: "該当なし。",
  searchResults: "結果",
  onThisPage: "このページ内",
  previous: "前へ",
  next: "次へ",
  pagination: "ページ送り",
  continueTo: "はじめに へ進む。",
};

export default ja;
