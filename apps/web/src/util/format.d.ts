/** 展示格式化：时间戳本地化、字节数、时长——契约里时间戳一律是毫秒 Unix，本地化由前端负责。 */
export declare function formatDateTime(ms: number | null | undefined): string;
export declare function formatRelative(ms: number | null | undefined): string;
export declare function formatBytes(bytes: number | null | undefined): string;
export declare function formatDuration(ms: number | null | undefined): string;
export declare function formatPercent(ratio: number | null | undefined, digits?: number): string;
