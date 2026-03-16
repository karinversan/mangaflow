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
    text: "Поддержка PNG/JPEG/WEBP. Страница сразу отображается в рабочем пространстве редактора."
  },
  {
    id: "02",
    title: "Детекция + OCR",
    text: "YOLOv11s-seg находит текстовые области (bubble, sfx, narrative), MangaOCR распознаёт японский текст."
  },
  {
    id: "03",
    title: "Перевод + Инпейнтинг",
    text: "LLM переводит текст через OpenRouter API. SimpleLama удаляет оригинальный текст с фона."
  },
  {
    id: "04",
    title: "Ручная редактура и экспорт",
    text: "Двигайте точки полигонов, правьте перевод, удаляйте лишние блоки и экспортируйте результат."
  }
];

const features = [
  {
    title: "Редактор полигонов",
    text: "Перемещение вершин сегментации, удаление ненужных регионов, коррекция перевода для каждого блока."
  },
  {
    title: "Pluggable ML-провайдеры",
    text: "Архитектура провайдеров: легко заменить модель детекции, OCR или перевода без изменений фронтенда."
  },
  {
    title: "Production-ready стек",
    text: "Docker Compose, FastAPI, Postgres, Redis очереди с retry и dead-letter, MinIO для артефактов, JWT-аутентификация."
  }
];

const mlMetrics = [
  { label: "mAP@50 (Mask)", value: "39.4%" },
  { label: "mAP@50-95 (Mask)", value: "26.4%" },
  { label: "Dice (bubble_text)", value: "0.784" },
  { label: "Precision", value: "45.3%" },
  { label: "Recall", value: "29.9%" },
  { label: "Классов", value: "5" },
];

const pipeline = [
  {
    stage: "Detect",
    model: "YOLOv11s-seg",
    detail: "10.4M параметров, 34.1 GFLOPs. Дообучена на вручную размеченном датасете манги (5 классов)."
  },
  {
    stage: "OCR",
    model: "MangaOCR",
    detail: "Vision Encoder-Decoder модель, специализированная на японском тексте в манге. Работает локально."
  },
  {
    stage: "Translate",
    model: "OpenRouter LLM",
    detail: "Перевод через API крупных языковых моделей. Поддержка 12+ языков."
  },
  {
    stage: "Clean",
    model: "SimpleLama",
    detail: "LaMa (Large Mask Inpainting) — удаление текста с фона по полигональным маскам."
  },
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
            <a href="#pipeline" className="hover:text-white">
              ML Pipeline
            </a>
            <a href="#metrics" className="hover:text-white">
              Метрики
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

        <section id="pipeline" className="mx-auto w-full max-w-7xl px-6 pb-14">
          <RevealOnScroll>
            <h2 className="mb-2 text-3xl font-semibold">ML Pipeline</h2>
            <p className="mb-6 max-w-3xl text-sm text-white/60">
              Каждая стадия использует отдельную ML-модель. Архитектура провайдеров позволяет заменить любую модель без изменения фронтенда.
            </p>
          </RevealOnScroll>
          <div className="grid gap-4 md:grid-cols-2">
            {pipeline.map((item, index) => (
              <RevealOnScroll key={item.stage} delayMs={index * 100}>
                <article className="panel rounded-2xl p-5">
                  <div className="flex items-center gap-3">
                    <span className="rounded-lg bg-[#ff9d42]/20 px-3 py-1 text-xs font-bold uppercase tracking-wider text-[#ff9d42]">
                      {item.stage}
                    </span>
                    <span className="text-sm font-semibold text-white/90">{item.model}</span>
                  </div>
                  <p className="mt-3 text-sm text-white/70">{item.detail}</p>
                </article>
              </RevealOnScroll>
            ))}
          </div>
        </section>

        <section id="metrics" className="mx-auto w-full max-w-7xl px-6 pb-14">
          <RevealOnScroll>
            <h2 className="mb-2 text-3xl font-semibold">Метрики детекции</h2>
            <p className="mb-6 max-w-3xl text-sm text-white/60">
              Результаты YOLOv11s-seg на тестовой выборке (10 изображений, 160 аннотаций). Датасет размечен вручную.
            </p>
          </RevealOnScroll>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {mlMetrics.map((m, index) => (
              <RevealOnScroll key={m.label} delayMs={index * 80}>
                <div className="panel rounded-2xl p-4 text-center">
                  <p className="text-2xl font-bold text-[#ff9d42]">{m.value}</p>
                  <p className="mt-1 text-xs text-white/60">{m.label}</p>
                </div>
              </RevealOnScroll>
            ))}
          </div>

          <RevealOnScroll delayMs={200}>
            <div className="panel mt-4 overflow-hidden rounded-2xl">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-white/50">
                    <th className="px-5 py-3">Класс</th>
                    <th className="px-5 py-3">Dice</th>
                    <th className="px-5 py-3">IoU</th>
                    <th className="px-5 py-3">Изображений</th>
                  </tr>
                </thead>
                <tbody className="text-white/80">
                  <tr className="border-b border-white/5"><td className="px-5 py-2.5">bubble_text</td><td className="px-5 py-2.5 font-semibold text-[#ff9d42]">0.784</td><td className="px-5 py-2.5">0.667</td><td className="px-5 py-2.5">8</td></tr>
                  <tr className="border-b border-white/5"><td className="px-5 py-2.5">sfx</td><td className="px-5 py-2.5">0.385</td><td className="px-5 py-2.5">0.319</td><td className="px-5 py-2.5">8</td></tr>
                  <tr className="border-b border-white/5"><td className="px-5 py-2.5">background_text</td><td className="px-5 py-2.5">0.023</td><td className="px-5 py-2.5">0.012</td><td className="px-5 py-2.5">5</td></tr>
                  <tr className="border-b border-white/5"><td className="px-5 py-2.5">meta_text</td><td className="px-5 py-2.5">0.010</td><td className="px-5 py-2.5">0.005</td><td className="px-5 py-2.5">4</td></tr>
                  <tr className="border-b border-white/5"><td className="px-5 py-2.5">narration_text</td><td className="px-5 py-2.5">0.000</td><td className="px-5 py-2.5">0.000</td><td className="px-5 py-2.5">2</td></tr>
                  <tr className="font-semibold"><td className="px-5 py-2.5">Среднее</td><td className="px-5 py-2.5">0.240</td><td className="px-5 py-2.5">0.200</td><td className="px-5 py-2.5">—</td></tr>
                </tbody>
              </table>
            </div>
          </RevealOnScroll>
        </section>

        <section id="stack" className="mx-auto w-full max-w-7xl px-6 pb-24">
          <RevealOnScroll>
            <div className="panel rounded-3xl p-7">
              <h2 className="text-3xl font-semibold">Технологический стек</h2>
              <p className="mt-3 max-w-4xl text-sm text-white/75">
                Full-stack ML-платформа: Next.js фронтенд, FastAPI бэкенд с асинхронными Redis-очередями,
                PostgreSQL для метаданных, MinIO для артефактов. Всё запускается через Docker Compose одной командой.
              </p>
              <div className="mt-6 grid grid-cols-2 gap-3 text-sm text-white/80 md:grid-cols-4">
                <span className="rounded-xl bg-black/30 px-4 py-3">Next.js 15 + TS</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">FastAPI + Python 3.12</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">YOLOv11 + MangaOCR</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">SimpleLama + OpenRouter</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">PostgreSQL 15</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">Redis 7 (очереди)</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">MinIO (S3)</span>
                <span className="rounded-xl bg-black/30 px-4 py-3">Docker Compose</span>
              </div>
            </div>
          </RevealOnScroll>
        </section>
      </div>
          <Footer />
    </main>
  );
}
