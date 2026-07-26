import { Navigate, Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth';
import { AccountsPage } from './pages/AccountsPage';
import { AddAccountPage } from './pages/AddAccountPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route
        path="/overview"
        element={
          <RequireAuth>
            <OverviewPage />
          </RequireAuth>
        }
      />
      <Route
        path="/accounts"
        element={
          <RequireAuth>
            <AccountsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/accounts/add"
        element={
          <RequireAuth>
            <AddAccountPage />
          </RequireAuth>
        }
      />
      <Route
        path="/api-keys"
        element={
          <RequireAuth>
            <ApiKeysPage />
          </RequireAuth>
        }
      />
      <Route
        path="/requests"
        element={
          <RequireAuth>
            <PlaceholderPage title="请求" subtitle="请求记录查询" note="/admin/requests 接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/capabilities"
        element={
          <RequireAuth>
            <PlaceholderPage title="模型与能力" subtitle="模型列表与能力矩阵" note="/admin/capabilities 接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/files"
        element={
          <RequireAuth>
            <PlaceholderPage title="文件" subtitle="已上传文件的管理视角" note="/admin/files 接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/proxies"
        element={
          <RequireAuth>
            <PlaceholderPage title="代理池" subtitle="出口代理节点管理" note="/admin/proxies 接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/oauth"
        element={
          <RequireAuth>
            <PlaceholderPage title="OAuth" subtitle="OAuth 端点与客户端设置" note="/admin/settings（分组 oauth）接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/scheduler"
        element={
          <RequireAuth>
            <PlaceholderPage title="调度" subtitle="账号调度与重试策略" note="/admin/settings（分组 scheduler）接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/logging"
        element={
          <RequireAuth>
            <PlaceholderPage title="日志" subtitle="日志隐私模式" note="/admin/settings（分组 logging）接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/system"
        element={
          <RequireAuth>
            <PlaceholderPage title="系统设置" subtitle="网络、工具与文件相关设置" note="/admin/settings（分组 network/tools/files）接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/codex-config"
        element={
          <RequireAuth>
            <PlaceholderPage title="Codex 配置" subtitle="生成可粘贴的 config.toml 片段" note="/admin/codex-config 接入中。" />
          </RequireAuth>
        }
      />
      <Route
        path="/backup"
        element={
          <RequireAuth>
            <PlaceholderPage title="备份与恢复" subtitle="数据库与文件备份" note="/admin/backup、/admin/restore 属于 M8，接入中。" />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
