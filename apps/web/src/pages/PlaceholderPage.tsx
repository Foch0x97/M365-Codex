import { Layout } from '../components/Layout';

/** 尚未完善的页面占位：能正常进入、不白屏，避免用户点导航时以为应用挂了。 */
export function PlaceholderPage({ title, subtitle, note }: { title: string; subtitle: string; note: string }) {
  return (
    <Layout title={title} subtitle={subtitle}>
      <div className="card state-block">
        <div className="state-title">功能建设中</div>
        <div>{note}</div>
      </div>
    </Layout>
  );
}
