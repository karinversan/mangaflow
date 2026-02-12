import Link from "next/link";

export function Header() {
  return (
    <header className="relative z-20 mx-auto w-full max-w-7xl px-6 py-6">
      <div className="panel flex items-center justify-between rounded-2xl px-5 py-4">
        <Link href="/" className="text-2xl font-semibold tracking-tight">
          Manga<span className="text-warm">Flow</span>
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/#about" className="rounded-full px-4 py-2 hover:bg-white/10">
            Возможности
          </Link>
          <Link href="/#pipeline" className="rounded-full px-4 py-2 hover:bg-white/10">
            Архитектура
          </Link>
          <Link href="/editor" className="rounded-full bg-white px-4 py-2 font-semibold text-black">
            Открыть редактор
          </Link>
        </nav>
      </div>
    </header>
  );
}
