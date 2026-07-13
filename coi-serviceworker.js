/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        // このデモ独自の追加 (1/2): cross-origin リクエストは素通しする。この
        // ページの cross-origin fetch は、c2w-net-proxy がゲストの HTTP を変換
        // した CORS 管理下のものだけで、SW の再構築は何も加えない。ゲスト
        // Chromium のテレメトリ (accounts.google.com 等、CORS 非対応で決定的に
        // 失敗する) を下のリトライにかけるのは無意味で、ログと遅延を増やすだけ。
        // COEP: credentialless 下の cross-origin 取得はブラウザ自体が管理する
        // ため isolation は保たれる。
        if (new URL(r.url).origin !== self.location.origin) {
            return;
        }

        // このデモ独自の追加 (2/2): wasm パーツ (/wasm/) も素通しする。数百 MB
        // のダウンロード中にネットワーク変化 (ERR_NETWORK_CHANGED) が起きた場合
        // の再開処理は demo-worker.js が Range リクエストで行うため、SW で応答を
        // 再構築するとその再開の妨げになるだけで利点がない。same-origin
        // サブリソースは COEP: require-corp 下でも CORP 不要で読めるため
        // cross-origin isolation は保たれる (計測でも fromServiceWorker=false /
        // crossOriginIsolated=true を確認)。なお worker スクリプト自体
        // (demo-worker.js 等) は素通しではダメで、SW の COEP 付与が必要 (付与が
        // ないと coep-frame-resource-needs-coep-header でブロックされる。実測済み)。
        if (/\/wasm\//.test(r.url)) {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith((async () => {
            // このデモ独自の変更: SW 内部の fetch は、OS のネットワーク変化
            // (VPN/docker/DHCP 更新等) を Chrome が検知した瞬間に全接続が
            // ERR_NETWORK_CHANGED で破棄されると reject する (netlog で実測)。
            // 元実装は失敗を undefined に変換して FetchEvent 全体をネットワーク
            // エラーにするため、一時的な切断が「死んだページ」になる。リトライで
            // 吸収し、navigate はそれでも失敗したら自動再試行ページを返す。
            let response;
            try {
                response = await fetch(request);
            } catch (e) {
                if (r.method !== "GET") {
                    console.error(e);
                    return Response.error();
                }
                // 再試行は URL ベースの新しいリクエストで行い、切断済み
                // コネクションやキャッシュ競合 (ERR_CACHE_RACE) を避ける
                let lastErr = e;
                for (const delay of [500, 1000, 2000]) {
                    await new Promise((res) => setTimeout(res, delay));
                    try {
                        response = await fetch(r.url, {
                            cache: "no-store",
                            credentials: "same-origin",
                            redirect: "follow",
                        });
                        lastErr = null;
                        break;
                    } catch (e2) {
                        lastErr = e2;
                    }
                }
                if (lastErr) {
                    console.error(lastErr);
                    if (r.mode === "navigate") {
                        return new Response(
                            '<!doctype html><meta charset="utf-8">' +
                            '<meta http-equiv="refresh" content="2">' +
                            "<title>再接続中</title>" +
                            "<p>ネットワークが一時的に切断されました。自動的に再試行します…</p>",
                            {
                                status: 503,
                                headers: {
                                    "Content-Type": "text/html; charset=utf-8",
                                    "Cross-Origin-Embedder-Policy":
                                        coepCredentialless ? "credentialless" : "require-corp",
                                    "Cross-Origin-Opener-Policy": "same-origin",
                                },
                            }
                        );
                    }
                    return Response.error();
                }
            }
            if (response.status === 0) {
                return response;
            }

            const newHeaders = new Headers(response.headers);
            newHeaders.set("Cross-Origin-Embedder-Policy",
                coepCredentialless ? "credentialless" : "require-corp"
            );
            if (!coepCredentialless) {
                newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
            }
            newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });
        })());
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        // Record the failure if the page is served by serviceWorker.
        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            // Reload only on the first failure.
            const reloadToDegrade = coi.coepDegrade() && !(
                coepDegrading || window.crossOriginIsolated
            );
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Firefox private mode) this won't be available
        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    coi.doReload();
                });

                // If the registration is active, but it's not controlling the page
                if (registration.active && !n.serviceWorker.controller) {
                    !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}
