import Link from "next/link";
import { EditorWorkbench } from "@/components/EditorWorkbench";
import { Footer } from "@/components/Footer";

export default function EditorPage() {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_12%_10%,rgba(255,157,66,0.24),transparent_35%),linear-gradient(145deg,#0a0b10_5%,#121622_58%,#1b1f2a_100%)]"
      />

      <header className="relative z-20 mx-auto w-full max-w-[1580px] px-4 py-5">
        <Link href="/" className="inline-flex text-3xl font-semibold tracking-tight">
          Manga<span className="text-[#ff9d42]">Flow</span>
        </Link>
      </header>

      <section className="relative z-10 mx-auto w-full max-w-[1580px] px-4 pb-4">
        <h1 className="text-3xl font-semibold sm:text-4xl">Manga Translation Editor</h1>
        <p className="mt-2 max-w-4xl text-sm text-white/70 sm:text-base">
          Полноэкранный редактор для production-потока: запуск pipeline, ручная корректировка сегментов, QA и экспорт.
        </p>
      </section>

      <div className="relative z-10 flex-1">
        <EditorWorkbench />
      </div>

      <div className="relative z-10 mt-4">
        <Footer />
      </div>
    </main>
  );
}
