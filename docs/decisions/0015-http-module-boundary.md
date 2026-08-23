# ADR-0015: HTTP モジュールの通信境界

- **Status**: Accepted
- **Date**: 2026-08-23
- **Related**: requirements §3.4 / ADR-0009 / module-contract §3.4

## Context

HTTP request の実験機能は任意の開発 endpoint へ通信する必要がある。WebView の `fetch` は CORS や platform 差の影響を受け、通信内容に Authorization 等の秘密値が含まれる可能性もある。

## Decision

- 通信は Rust の `http_send_request` command のみに閉じ、Frontend `fetch` と `tauri-plugin-http` は使わない。
- `http` / `https` のみ許可し、localhost / private address は開発用途として許可する。
- module は stateless、既定無効とし、request / response / header / body を保存・ログ出力しない。
- timeout、redirect 回数、response size に上限を設け、既存 OperationRegistry で cancel 可能にする。
- TLS 検証無効化、cookie jar、multipart、file upload、proxy configuration は提供しない。

## Consequences

- CSP や CORS に依存せず macOS / Windows で同じ IPC contract を使える。
- ネットワーク機能はオフライン主要機能から分離され、利用者が設定画面で明示的に有効化する。
- 将来高度な client 機能を追加する場合は本 ADR を supersede する新 ADR が必要になる。
