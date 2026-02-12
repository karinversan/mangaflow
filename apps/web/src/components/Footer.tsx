import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-black/25">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-5 text-sm text-white/65 sm:flex-row sm:items-center sm:justify-between">
        <p>© {new Date().getFullYear()} MangaFlow. AI-assisted manga translation workspace.</p>
        <div className="flex items-center gap-4">
          <Link href="/" className="hover:text-white">
            Главная
          </Link>
          <Link href="/editor" className="hover:text-white">
            Редактор
          </Link>
          <a href="/docs" className="pointer-events-none opacity-40">
            Docs (soon)
          </a>
        </div>
      </div>
    </footer>
  );
}
