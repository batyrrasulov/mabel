import { useEffect, useRef, useState } from "react";

import { getCurrentUser } from "@/lib/auth";

import { mabelUiEnabledConnectors } from "../connectorUi";
import type { MabelBootstrap, MabelConversationSummary } from "../types";

type WelcomePaneProps = {
  bootstrap: MabelBootstrap;
  conversations: MabelConversationSummary[];
  skillCount?: number;
  onStarter: (prompt: string, hiddenInstructions?: string) => void;
  playGame?: boolean;
  onPlayGameChange?: (next: boolean) => void;
};

const STARTERS: Array<{ label: string; prompt: string; hiddenInstructions?: string; featured?: boolean }> = [
  {
    label: "Create a custom skill",
    prompt: "Help me create a new Mabel skill.",
    hiddenInstructions:
      "Ask what the skill should do and which MCPs it needs, draft the instructions, then use mabel_create_skill to save it.",
  },
  {
    label: "Create a research dashboard",
    prompt: "Research today's most important AI platform developments and create a source-backed dashboard.",
    hiddenInstructions:
      "Use authoritative public sources. Generate and save a self-contained HTML dashboard, then include a CSV export of the underlying findings.",
    featured: true,
  },
  {
    label: "Show my Connectors",
    prompt: "Show my connected MCP connectors.",
    hiddenInstructions: "Use mabel_context and list the connected MCP connectors with their status and tool counts.",
  },
  {
    label: "Find me top AI news",
    prompt: "Find me today's top AI news.",
    hiddenInstructions:
      "Search the web for today's top AI industry news with sources. Save via mabel_memory_save that the user prefers AI-only news going forward.",
  },
];

export function WelcomePane({ bootstrap, conversations, skillCount, onStarter, playGame, onPlayGameChange }: WelcomePaneProps) {
  const user = getCurrentUser();
  const firstName = (user?.name || bootstrap.user?.name || user?.email || bootstrap.user?.email || "there").split(/[\s@]+/)[0] || "there";
  const sessions = conversations.length;
  const skills = skillCount ?? bootstrap.skills.length;
  const connectors = mabelUiEnabledConnectors(bootstrap.connectors).length;
  const starterPacks = bootstrap.starter_packs.length;
  const [localShowGame, setLocalShowGame] = useState(false);
  const showGame = playGame ?? localShowGame;
  const setShowGame = (next: boolean) => {
    if (onPlayGameChange) {
      onPlayGameChange(next);
    } else {
      setLocalShowGame(next);
    }
  };

  return (
    <div className="mabel-welcome">
      <div className="mabel-welcome__hero">
        <h2 className="mabel-welcome__title">Welcome, {firstName}</h2>
        <p className="mabel-welcome__sub">Open agent workspace</p>
      </div>

      <div className="mabel-welcome__stats">
        <StatCard label="Chats" value={sessions} hint="Recent" />
        <StatCard label="Skills" value={skills} hint="Installed" />
        <StatCard label="MCPs" value={connectors} hint="Connected" />
        <StatCard label="Tasks" value={starterPacks} hint="Available" />
      </div>

      <div className="mabel-welcome__starters">
        <div className="mabel-welcome__section-label">Examples</div>
        <div className="mabel-welcome__starter-grid">
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className={`mabel-welcome__starter${starter.featured ? " mabel-welcome__starter--featured" : ""}`}
              onClick={() => onStarter(starter.prompt, starter.hiddenInstructions)}
            >
              <span>{starter.label}</span>
              <ArrowRight />
            </button>
          ))}
        </div>
      </div>

      <div className="mabel-welcome__game">
        <div className="mabel-welcome__game-head">
          <div>
            <div className="mabel-welcome__section-label">Mabel Snake</div>
            <p className="mabel-welcome__game-sub">Take a quick break. Each apple is a Mabel tip.</p>
          </div>
          <button
            type="button"
            className="mabel-welcome__game-toggle"
            onClick={() => setShowGame(!showGame)}
            aria-expanded={showGame}
          >
            {showGame ? "Close" : "Play"}
          </button>
        </div>
        {showGame ? <MabelSnake /> : null}
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="mabel-stat">
      <div className="mabel-stat__value">{value}</div>
      <div className="mabel-stat__label">{label}</div>
      <div className="mabel-stat__hint">{hint}</div>
    </div>
  );
}

function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

/* Tiny Snake game for the welcome state — easy mode: slow tick, snake doesn't auto-move
 * until the player first presses an arrow key, food spawns randomly each apple. */
type Cell = [number, number];

const GRID = 16;
const SPEED_MS = 260;
const TIPS = [
  "Use /skills to browse governed skills.",
  "Use @connector to scope a tool.",
  "Use + to attach a file.",
  "Type /mcp to list connectors.",
  "Approvals pause writes by default.",
];

const INITIAL_SNAKE: Cell[] = [[8, 8], [7, 8], [6, 8]];

function randomFood(snake: Cell[]): Cell {
  while (true) {
    const candidate: Cell = [Math.floor(Math.random() * GRID), Math.floor(Math.random() * GRID)];
    if (!snake.some(([x, y]) => x === candidate[0] && y === candidate[1])) {
      return candidate;
    }
  }
}

function MabelSnake() {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [snake, setSnake] = useState<Cell[]>(INITIAL_SNAKE);
  const [food, setFood] = useState<Cell>([12, 12]);
  const [direction, setDirection] = useState<Cell | null>(null);
  const [pendingDirection, setPendingDirection] = useState<Cell | null>(null);
  const [running, setRunning] = useState(true);
  const [started, setStarted] = useState(false);
  const [score, setScore] = useState(0);
  const [tip, setTip] = useState<string>(TIPS[0]);
  const [focused, setFocused] = useState(false);
  const tickRef = useRef<number | null>(null);

  const reset = () => {
    setSnake(INITIAL_SNAKE);
    setFood(randomFood(INITIAL_SNAKE));
    setDirection(null);
    setPendingDirection(null);
    setRunning(true);
    setStarted(false);
    setScore(0);
    setTip(TIPS[0]);
    boardRef.current?.focus();
  };

  // Keyboard input — only consumed when the game has focus and is running
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!focused || !running) return;
      const map: Record<string, Cell> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      const next = map[event.key];
      if (!next) return;
      event.preventDefault();
      // prevent direct reversal
      if (direction && direction[0] === -next[0] && direction[1] === -next[1]) return;
      setPendingDirection(next);
      setStarted(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [direction, focused, running]);

  useEffect(() => {
    if (!running || !started) return;
    tickRef.current = window.setInterval(() => {
      setSnake((prev) => {
        const dir = pendingDirection || direction || [1, 0];
        if (pendingDirection) setDirection(pendingDirection);
        const head = prev[0];
        const next: Cell = [head[0] + dir[0], head[1] + dir[1]];
        if (next[0] < 0 || next[0] >= GRID || next[1] < 0 || next[1] >= GRID) {
          setRunning(false);
          return prev;
        }
        if (prev.some(([x, y]) => x === next[0] && y === next[1])) {
          setRunning(false);
          return prev;
        }
        const ate = next[0] === food[0] && next[1] === food[1];
        const newSnake = ate ? [next, ...prev] : [next, ...prev.slice(0, prev.length - 1)];
        if (ate) {
          setScore((s) => s + 1);
          setTip(TIPS[(score + 1) % TIPS.length]);
          setFood(randomFood(newSnake));
        }
        return newSnake;
      });
    }, SPEED_MS);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [direction, pendingDirection, food, running, started, score]);

  return (
    <div className="mabel-snake">
      <div
        ref={boardRef}
        className="mabel-snake__board"
        tabIndex={0}
        role="application"
        aria-label="Mabel Snake game"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => boardRef.current?.focus()}
      >
        {Array.from({ length: GRID * GRID }).map((_, idx) => {
          const x = idx % GRID;
          const y = Math.floor(idx / GRID);
          const isSnake = snake.some(([sx, sy]) => sx === x && sy === y);
          const isHead = snake[0][0] === x && snake[0][1] === y;
          const isFood = food[0] === x && food[1] === y;
          return (
            <div
              key={idx}
              className={
                "mabel-snake__cell" +
                (isFood ? " mabel-snake__cell--food" : "") +
                (isSnake ? (isHead ? " mabel-snake__cell--head" : " mabel-snake__cell--body") : "")
              }
            />
          );
        })}
      </div>
      <div className="mabel-snake__side">
        <div className="mabel-snake__score">Score · {score}</div>
        <p className="mabel-snake__tip">{tip}</p>
        {!running ? (
          <button type="button" className="mabel-snake__reset" onClick={reset}>
            Reset
          </button>
        ) : !started ? (
          <p className="mabel-snake__hint">{focused ? "Press an arrow key to start" : "Click the board, then arrows to move"}</p>
        ) : (
          <p className="mabel-snake__hint">Arrow keys to move</p>
        )}
      </div>
    </div>
  );
}
