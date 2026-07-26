/** 展示格式化：时间戳本地化、字节数、时长——契约里时间戳一律是毫秒 Unix，本地化由前端负责。 */
export function formatDateTime(ms) {
    if (ms === null || ms === undefined)
        return '—';
    return new Date(ms).toLocaleString();
}
export function formatRelative(ms) {
    if (ms === null || ms === undefined)
        return '—';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    let text;
    if (abs < minute)
        text = '刚刚';
    else if (abs < hour)
        text = `${Math.round(abs / minute)} 分钟`;
    else if (abs < day)
        text = `${Math.round(abs / hour)} 小时`;
    else
        text = `${Math.round(abs / day)} 天`;
    if (text === '刚刚')
        return text;
    return diff < 0 ? `${text}前` : `${text}后`;
}
export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined)
        return '—';
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}
export function formatDuration(ms) {
    if (ms === null || ms === undefined)
        return '—';
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days > 0)
        parts.push(`${days} 天`);
    if (hours > 0)
        parts.push(`${hours} 小时`);
    if (minutes > 0 || parts.length === 0)
        parts.push(`${minutes} 分钟`);
    return parts.join(' ');
}
export function formatPercent(ratio, digits = 1) {
    if (ratio === null || ratio === undefined || Number.isNaN(ratio))
        return '—';
    return `${(ratio * 100).toFixed(digits)}%`;
}
