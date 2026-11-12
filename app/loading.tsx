export default function Loading() {
  return (
    <main
      className="chronexa-loading"
      role="status"
      aria-live="polite"
      aria-label="Loading Chronexa"
    >
      <div className="chronexa-loader-mark" aria-hidden="true" />
      <p className="chronexa-loading-label">Preparing your financial timeline</p>
    </main>
  );
}
