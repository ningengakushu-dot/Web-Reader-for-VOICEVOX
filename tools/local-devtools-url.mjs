// ローカル画像を渡すDevTools接続を、起動したChromeのloopbackポートに限定する。
// /json/new の応答が別ホストを指しても、そのURLを画像の送信先として信用しない。
export function localDevtoolsUrl(value, port) {
    if (typeof value !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('DevToolsの接続先が不正です');
    }
    const url = new URL(value);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port)
        || url.username || url.password || url.search || url.hash
        || !/^\/devtools\/page\/[a-z0-9-]+$/i.test(url.pathname)) {
        throw new Error('DevToolsの接続先は起動したChromeのローカルポートに限ります');
    }
    return `ws://127.0.0.1:${port}${url.pathname}`;
}
