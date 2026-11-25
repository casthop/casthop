export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <a className="brand" href="/" aria-label="Casthop home">
      <span className="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M6.2 4.2v9.6L14.4 9 6.2 4.2Z" fill="white" />
        </svg>
      </span>
      <span className="word" style={{ color: dark ? "#16171c" : undefined }}>
        Casthop
      </span>
    </a>
  );
}
