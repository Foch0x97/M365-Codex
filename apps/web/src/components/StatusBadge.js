import { jsx as _jsx } from "react/jsx-runtime";
function Badge({ tone, label }) {
    return _jsx("span", { className: `badge badge-${tone}`, children: label });
}
const ACCOUNT_STATUS_MAP = {
    probing: { label: '探测中', tone: 'info' },
    online: { label: '在线', tone: 'ok' },
    busy: { label: '忙碌', tone: 'info' },
    cooldown: { label: '冷却中', tone: 'warn' },
    reauth_required: { label: '需重新授权', tone: 'danger' },
    disabled: { label: '已停用', tone: 'neutral' },
    unsupported: { label: '能力不满足', tone: 'neutral' },
    error: { label: '错误', tone: 'danger' },
};
export function AccountStatusBadge({ status }) {
    const entry = ACCOUNT_STATUS_MAP[status] ?? { label: status, tone: 'neutral' };
    return _jsx(Badge, { tone: entry.tone, label: entry.label });
}
const SYSTEM_STATUS_MAP = {
    normal: { label: '正常', tone: 'ok' },
    degraded: { label: '降级', tone: 'warn' },
    maintenance: { label: '维护中', tone: 'info' },
    upstream_unavailable: { label: '上游不可用', tone: 'danger' },
    migration_failed: { label: '迁移失败', tone: 'danger' },
};
export function SystemStatusBadge({ status }) {
    const entry = SYSTEM_STATUS_MAP[status] ?? { label: status, tone: 'neutral' };
    return _jsx(Badge, { tone: entry.tone, label: entry.label });
}
const RESPONSE_STATUS_MAP = {
    queued: { label: '排队中', tone: 'neutral' },
    in_progress: { label: '进行中', tone: 'info' },
    completed: { label: '已完成', tone: 'ok' },
    incomplete: { label: '未完成', tone: 'warn' },
    failed: { label: '失败', tone: 'danger' },
    cancelled: { label: '已取消', tone: 'neutral' },
};
export function ResponseStatusBadge({ status }) {
    const entry = RESPONSE_STATUS_MAP[status] ?? { label: status, tone: 'neutral' };
    return _jsx(Badge, { tone: entry.tone, label: entry.label });
}
const PROXY_STATUS_MAP = {
    unknown: { label: '未检测', tone: 'neutral' },
    healthy: { label: '健康', tone: 'ok' },
    unhealthy: { label: '异常', tone: 'danger' },
    cooldown: { label: '冷却中', tone: 'warn' },
};
export function ProxyStatusBadge({ status }) {
    const entry = PROXY_STATUS_MAP[status] ?? { label: status, tone: 'neutral' };
    return _jsx(Badge, { tone: entry.tone, label: entry.label });
}
const CAPABILITY_STATUS_MAP = {
    native: { label: '原生支持', tone: 'ok' },
    local: { label: '本地实现', tone: 'ok' },
    upstream_decided: { label: '取决于上游', tone: 'warn' },
    experimental: { label: '实验性', tone: 'info' },
    unsupported: { label: '不支持', tone: 'neutral' },
};
export function CapabilityStatusBadge({ status }) {
    const entry = CAPABILITY_STATUS_MAP[status] ?? { label: status, tone: 'neutral' };
    return _jsx(Badge, { tone: entry.tone, label: entry.label });
}
export function BoolBadge({ value, trueLabel, falseLabel }) {
    return value ? _jsx(Badge, { tone: "ok", label: trueLabel }) : _jsx(Badge, { tone: "neutral", label: falseLabel });
}
