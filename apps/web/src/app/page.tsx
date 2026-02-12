import Link from "next/link";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { Footer } from "@/components/Footer";
import { TypingLine } from "@/components/TypingLine";

const typedLines = [
  "Загружаете страницу манги и выбираете язык перевода.",
  "Pipeline находит текстовые пузыри, очищает фон и готовит черновой перевод.",
  "В редакторе вы вручную правите текст, двигаете блоки и экспортируете финал."
];

const steps = [
  {
    id: "01",
    title: "Загрузка страницы",
    text: "Поддержка PNG/JPEG/WEBP. Страница сразу отображается в рабочем пространстве."
  },
  {
    id: "02",
    title: "Авто-обработка",
    text: "Детекция текстовых областей, OCR и черновой перевод. Сейчас подключена stub-модель."
  },
  {
    id: "03",
    title: "Ручная редактура",
    text: "Вы редактируете перевод, переставляете блоки и проверяете качество перед выпуском."
  },
  {
    id: "04",
    title: "Экспорт",
    text: "Можно сохранить структуру перевода в JSON и встроить в ваш дальнейший production pipeline."
  }
];

const features = [
  {
    title: "Редактор блоков",
    text: "Выбор сегмента, ручное изменение координат и текста, быстрый фокус на low-confidence блоках."
  },
  {
    title: "Контракт под ML",
    text: "Frontend не зависит от конкретной модели. Когда ваша модель готова, меняется только backend-адаптер."
  },
  {
    title: "Основа для продакшена",
    text: "Docker, FastAPI, Postgres, Redis, MinIO, CI и базовая security-конфигурация уже в проекте."
  }
];

export default function HomePage() {
  return (
    <main className="bg-[#07090f] text-white">
      <section className="relative min-h-screen overflow-hidden">
        <div
          aria-hidden
          className="ambient-motion absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url('/sample_page.png')" }}
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(255,152,58,0.30),transparent_38%),radial-gradient(circle_at_82%_16%,rgba(255,255,255,0.14),transparent_30%),linear-gradient(112deg,rgba(4,5,8,0.74)_8%,rgba(8,10,14,0.9)_54%,rgba(4,5,8,0.98)_100%)]"
        />

        <header className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-7">
          <Link href="/" className="text-3xl font-semibold tracking-tight">
            Manga<span className="text-[#ff9d42]">Flow</span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm text-white/80 lg:flex">
            <a href="#how" className="hover:text-white">
              Как работает
            </a>
            <a href="#features" className="hover:text-white">
              Возможности
            </a>
            <a href="#stack" className="hover:text-white">
              Стек
            </a>
            <Link href="/editor" className="rounded-full bg-white px-5 py-2 font-semibold text-black">
              Открыть редактор
            </Link>
          </nav>
        </header>

        <section className="relative z-10 mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-7xl items-center px-6 pb-12">
          <div className="max-w-5xl reveal">
            <p className="mb-5 text-xs uppercase tracking-[0.28em] text-white/65">AI manga translation platform</p>
            <h1 className="text-[clamp(2.4rem,9vw,7.5rem)] font-semibold leading-[0.9] tracking-[-0.03em] text-white/95">
              Удобный
              <br />
              workflow для
              <br />
              перевода манги
            </h1>

            <div className="mt-7 max-w-3xl text-balance">
              <TypingLine lines={typedLines} />
            </div>

            <div className="mt-10 flex flex-wrap gap-3">
              <Link
                href="/editor"
                className="rounded-full bg-[#ff9d42] px-7 py-3 text-sm font-semibold uppercase tracking-wide text-black"
              >
                Перейти в редактор
              </Link>
              <a
                href="#how"
                className="rounded-full bg-white/15 px-7 py-3 text-sm font-semibold uppercase tracking-wide text-white"
              >
                Смотреть процесс
              </a>
            </div>
          </div>
        </section>
      </section>

      <div className="bg-[linear-gradient(180deg,#0b0f1a_0%,#0a0e16_45%,#080b12_100%)]">
        <section id="how" className="mx-auto w-full max-w-7xl px-6 pb-14 pt-16">
          <RevealOnScroll>
            <h2 className="mb-6 text-3xl font-semibold">Как это работает</h2>
          </RevealOnScroll>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step, index) => (
              <RevealOnScroll key={step.id} delayMs={index * 120}>
                <article className="panel rounded-2xl p-5">
                  <p className="text-xs uppercase tracking-[0.2em] text-white/55">Step {step.id}</p>
                  <h3 className="mt-2 text-xl font-semibold text-white">{step.title}</h3>
                  <p className="mt-3 text-sm text-white/75">{step.text}</p>
                </article>
              </RevealOnScroll>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto w-full max-w-7xl px-6 pb-14">
          <RevealOnScroll>
            <h2 className="mb-6 text-3xl font-semibold">Ключевые возможности</h2>
          </RevealOnScroll>
          <div className="grid gap-4 md:grid-cols-3">
            {features.map((item, index) => (
              <RevealOnScroll key={item.title} delayMs={index * 110}>
                <article className="panel rounded-2xl p-6">
                  <h3 className="text-xl font-semibold">{item.title}</h3>
                  <p className="mt-3 text-sm text-white/75">{item.text}</p>
                </article>
              </RevealOnScroll>
            ))}
          </div>
        </section>

        <section id="stack" className="mx-auto w-full max-w-7xl px-6 pb-24">
          <RevealOnScroll>
            <div className="panel rounded-3xl p-7">
              <h2 className="text-3xl font-semibold">Что уже реализовано в этой версии</h2>
              <p className="mt-3 max-w-4xl text-sm text-white/75">
                Web-приложение (Next.js), API (FastAPI), stub-пайплайн под будущую ML-модель, хранение истории запусков,
                Docker Compose окружение и документация по архитектуре, безопасности, DevOps/MLOps. Это не просто макет,
                а рабочая база, которую можно развивать до production.
              </p>
              <div className="mt-6 grid grid-cols-2 gap-3 text-sm text-white/80 md:grid-cols-4">
                <span className="rounded-xl bg-black/30 px-4 py-3">Next.js + TS</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">FastAPI + Python</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">Postgres + Redis</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">MinIO + Docker</span>
              </div>
            </div>
          </RevealOnScroll>
        </section>
      </div>
          <Footer />
    </main>
  );
}
