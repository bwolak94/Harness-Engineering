/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Inspector dark theme palette
        canvas: "#0a0a0f", // deep background
        surface: "#111118", // panel background
        "surface-2": "#1a1a27", // raised element background
        border: "#1e1e2e", // subtle borders
        "border-2": "#2d2d44", // stronger borders
        // Accent — indigo, signals "active/running"
        accent: "#6366f1",
        "accent-dim": "#4f46e5",
        // Semantic event colours
        "ev-lifecycle": "#818cf8", // workflow.* events
        "ev-step": "#60a5fa", // step.planned
        "ev-tool": "#c084fc", // tool.called / tool.succeeded / tool.failed
        "ev-checkpoint": "#a1a1aa", // state.checkpointed
        "ev-success": "#4ade80", // succeeded / completed
        "ev-error": "#f87171", // failed
        "ev-warn": "#fbbf24", // suspended
        "ev-info": "#22d3ee", // resumed
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'Geist Mono'", "'Fira Code'", "Menlo", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn 0.25s ease-out",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
