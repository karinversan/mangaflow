import { EditorWorkbench } from "@/components/EditorWorkbench";

export default function EditorPage() {
  return (
    <main className="relative h-screen overflow-hidden bg-[#0a0b10]">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_12%_10%,rgba(255,157,66,0.12),transparent_35%),linear-gradient(145deg,#0a0b10_5%,#121622_58%,#1b1f2a_100%)]"
      />
      <div className="relative z-10 h-full">
        <EditorWorkbench />
      </div>
    </main>
  );
}
