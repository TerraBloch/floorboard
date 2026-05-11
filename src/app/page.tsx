/**
 * Floorboard is API-first. This page exists because the App Router expects
 * something at `/`. The real surface is /v1/*.
 */
export default function Home(): JSX.Element {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: '40rem' }}>
      <h1>Floorboard</h1>
      <p>
        Open-data aggregation layer for Bitcoin Ordinals listings. API endpoints
        live under <code>/v1/</code>.
      </p>
      <ul>
        <li><a href="/v1/health">/v1/health</a></li>
        <li><a href="/v1/collections">/v1/collections</a></li>
        <li>
          <a href="/v1/collections/nodemonkes">/v1/collections/:slug</a>
        </li>
        <li>
          <a href="/v1/collections/nodemonkes/listings">/v1/collections/:slug/listings</a>
        </li>
        <li>/v1/assets/:id/listings</li>
        <li>/v1/events?since=…</li>
      </ul>
      <p>
        <a href="https://github.com/TerraBloch/floorboard">github.com/TerraBloch/floorboard</a>
      </p>
    </main>
  );
}
