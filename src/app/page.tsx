"use client";

import { FormEvent, useMemo, useState } from "react";

import type { ChunkMatch, SourceId } from "@/lib/types";

type Mode = "search" | "chat";
type Role = "user" | "assistant";

type SourceOption = {
  label: string;
  value: SourceId | "";
};

type ChatSource = {
  id: string;
  source: SourceId;
  page: number | null;
  heading: string | null;
  similarity: number;
};

type ChatScene = {
  kind?: "artwork" | "generated";
  imageUrl?: string;
  svg?: string;
  caption: string;
  alt?: string;
  attribution?: string;
  sourceUrl?: string;
};

type SceneStatus = "idle" | "pending" | "done";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  sources?: ChatSource[];
  scene?: ChatScene;
  sceneStatus?: SceneStatus;
};

const SOURCE_OPTIONS: SourceOption[] = [
  { label: "All", value: "" },
  { label: "Gita", value: "gita" },
  { label: "Ramayana", value: "ramayana" },
  { label: "Mahabharata", value: "mahabharata" },
];

const EXAMPLE_QUERIES = [
  "Who is more powerful, Karna or Arjuna?",
  "What does Krishna teach about action?",
  "Where does Rama show restraint?",
];

const FOLLOW_UP_PROMPTS = [
  {
    label: "More context",
    message:
      "Expand the previous answer with MORE CONTEXT only: background, lineage, vows, curses, weapons, alliances, Krishna's counsel, and surrounding episodes for the same rivals/topic. Do not repeat the earlier verdict essay; add new explanatory background from the texts.",
  },
  {
    label: "Full battle story",
    message:
      "Tell the FULL BATTLE STORY step by step of the main duel(s) for the previous question. Use chronological stages, say who had the upper hand at each stage, cite pages, and do not reuse the comparison-essay format.",
  },
  {
    label: "More encounters",
    message:
      "List EVERY ENCOUNTER or clash in Context for the previous question. For each one: setting, what happens, who had the advantage, and citation. Do not rewrite the previous essay; give an encounter inventory.",
  },
] as const;

function sourceLabel(source: SourceId): string {
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function parseSseEvent(block: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
}

function SceneFrame({ scene, status }: { scene?: ChatScene; status?: SceneStatus }) {
  if (status === "pending") {
    return (
      <figure className="mb-5 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--mist)]/50 p-10 text-center">
        <span className="scene-pulse text-sm font-medium text-[var(--muted)]">
          Composing the scene...
        </span>
      </figure>
    );
  }

  if (!scene) {
    return null;
  }

  const isArtwork = scene.kind === "artwork";

  return (
    <figure className="mb-5 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--mist)]/40">
      {scene.imageUrl ? (
        <div className="scene-viewport">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote image, no loader needed */}
          <img
            src={scene.imageUrl}
            alt={scene.alt ?? scene.caption}
            loading="lazy"
            decoding="async"
            /* Real paintings keep their colour; only generated art is forced to ink. */
            className={`scene-kenburns ${isArtwork ? "" : "scene-stage"}`}
          />
          <span aria-hidden className="scene-grain" />
        </div>
      ) : scene.svg ? (
        /* Fallback path: SVG is sanitized server-side by sanitizeSvg. */
        <div
          className="scene-stage [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: scene.svg }}
        />
      ) : null}
      {scene.caption ? (
        <figcaption className="border-t border-[var(--line)] bg-white/60 px-4 py-2.5">
          <span className="font-serif text-sm italic text-[var(--ink)]">{scene.caption}</span>
          {scene.attribution ? (
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              {scene.attribution}
              {scene.sourceUrl ? (
                <>
                  {" · "}
                  <a
                    href={scene.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-2 hover:text-[var(--ink)]"
                  >
                    Wikimedia Commons
                  </a>
                </>
              ) : null}
            </span>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("search");
  const [source, setSource] = useState<SourceId | "">("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChunkMatch[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceName = useMemo(
    () => SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? "All",
    [source],
  );

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const query = searchQuery.trim();

    if (!query) {
      setError("Enter a question or phrase to search.");
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          limit: 8,
          ...(source ? { source } : {}),
        }),
      });

      const payload = (await response.json()) as { results?: ChunkMatch[]; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Search failed.");
      }

      setSearchResults(payload.results ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed.");
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  async function sendChatMessage(rawContent: string) {
    const content = rawContent.trim();

    if (!content) {
      setError("Enter a message to chat.");
      return;
    }

    if (isChatting) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };

    setMode("chat");
    setChatMessages((messages) => [...messages, userMessage, assistantMessage]);
    setChatInput("");
    setIsChatting(true);
    setError(null);

    try {
      const history = [...chatMessages, userMessage].map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          ...(source ? { source } : {}),
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Chat failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const eventBlocks = buffer.split("\n\n");
        buffer = eventBlocks.pop() ?? "";

        for (const eventBlock of eventBlocks) {
          const parsed = parseSseEvent(eventBlock);

          if (!parsed) {
            continue;
          }

          if (parsed.event === "token") {
            const token = parsed.data as { content?: unknown };

            if (typeof token.content === "string") {
              const chunk = token.content;
              setChatMessages((messages) =>
                messages.map((message) =>
                  message.id === assistantMessage.id
                    ? { ...message, content: message.content + chunk }
                    : message,
                ),
              );
            }
          }

          if (parsed.event === "sources" && Array.isArray(parsed.data)) {
            const sources = parsed.data as ChatSource[];

            setChatMessages((messages) =>
              messages.map((message) =>
                message.id === assistantMessage.id ? { ...message, sources } : message,
              ),
            );
          }

          if (parsed.event === "scene-pending") {
            setChatMessages((messages) =>
              messages.map((message) =>
                message.id === assistantMessage.id
                  ? { ...message, sceneStatus: "pending" as SceneStatus }
                  : message,
              ),
            );
          }

          if (parsed.event === "scene") {
            const payload = parsed.data as Record<string, unknown>;
            const str = (key: string) =>
              typeof payload[key] === "string" && payload[key].length > 0
                ? (payload[key] as string)
                : undefined;
            const imageUrl = str("imageUrl");
            const svg = str("svg");
            const scene =
              imageUrl || svg
                ? {
                    kind: payload.kind === "artwork" ? ("artwork" as const) : ("generated" as const),
                    imageUrl,
                    svg,
                    caption: str("caption") ?? "",
                    alt: str("alt"),
                    attribution: str("attribution"),
                    sourceUrl: str("sourceUrl"),
                  }
                : undefined;

            setChatMessages((messages) =>
              messages.map((message) =>
                message.id === assistantMessage.id
                  ? { ...message, scene, sceneStatus: "done" as SceneStatus }
                  : message,
              ),
            );
          }

          if (parsed.event === "error") {
            const streamError = parsed.data as { error?: unknown };
            throw new Error(
              typeof streamError.error === "string" ? streamError.error : "Chat stream failed.",
            );
          }
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Chat failed.";

      setError(message);
      setChatMessages((messages) =>
        messages.map((chatMessage) =>
          chatMessage.id === assistantMessage.id
            ? {
                ...chatMessage,
                content: chatMessage.content || `Chat could not complete: ${message}`,
                sceneStatus: "done" as SceneStatus,
              }
            : chatMessage,
        ),
      );
    } finally {
      setIsChatting(false);
    }
  }

  async function handleChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendChatMessage(chatInput);
  }

  return (
    <main className="min-h-screen bg-[var(--stone)] text-[var(--ink)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10">
        <header className="grid gap-8 rounded-[2rem] border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[0_24px_90px_rgba(20,35,55,0.08)] sm:p-10 lg:grid-cols-[1fr_21rem]">
          <div className="max-w-3xl">
            <p className="mb-5 max-w-xl text-sm leading-6 text-[var(--muted)]">
              Read across the Bhagavad Gita, Ramayana, and Mahabharata with passages kept close to
              the answer.
            </p>
            <h1 className="font-serif text-5xl font-semibold leading-[0.95] tracking-[-0.04em] text-[var(--ink)] sm:text-7xl">
              Historic India
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">
              Search translated epic passages or ask a focused question. Results stay grounded in
              the retrieved text and show where each answer came from.
            </p>
          </div>
          <aside className="flex flex-col justify-between rounded-[1.5rem] bg-[var(--ink)] p-5 text-white">
            <div>
              <p className="text-sm text-white/70">Current source</p>
              <p className="mt-2 font-serif text-3xl font-semibold">{sourceName}</p>
            </div>
            <p className="mt-10 text-sm leading-6 text-white/70">
              Use All for comparison, then narrow to a single epic when a question needs textual
              precision.
            </p>
          </aside>
        </header>

        <section className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <aside className="rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-4">
            <div className="grid grid-cols-2 rounded-full bg-[var(--mist)] p-1">
              {(["search", "chat"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setMode(option);
                    setError(null);
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                    mode === option
                      ? "bg-[var(--ink)] text-white shadow-sm"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {option === "search" ? "Search" : "Chat"}
                </button>
              ))}
            </div>

            <label className="mt-6 block text-sm font-semibold text-[var(--ink)]" htmlFor="source">
              Source
            </label>
            <select
              id="source"
              value={source}
              onChange={(event) => setSource(event.target.value as SourceId | "")}
              className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--ochre)] focus:ring-4 focus:ring-[var(--ochre-soft)]"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="mt-6 rounded-2xl bg-[var(--mist)] p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Try asking</p>
              <div className="mt-3 flex flex-col gap-2">
                {EXAMPLE_QUERIES.map((query) => (
                  <button
                    key={query}
                    type="button"
                    onClick={() => (mode === "search" ? setSearchQuery(query) : setChatInput(query))}
                    className="rounded-xl bg-white px-3 py-2 text-left text-sm leading-5 text-[var(--muted)] transition hover:text-[var(--ink)]"
                  >
                    {query}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="min-h-[34rem] rounded-[1.5rem] border border-[var(--line)] bg-[var(--paper)] p-5 sm:p-6">
            {error ? (
              <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            ) : null}

            {mode === "search" ? (
              <div>
                <form onSubmit={handleSearch} className="flex flex-col gap-3 sm:flex-row">
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search for a passage, theme, or phrase"
                    className="min-h-12 flex-1 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 outline-none transition placeholder:text-[var(--muted)]/70 focus:border-[var(--ochre)] focus:ring-4 focus:ring-[var(--ochre-soft)]"
                  />
                  <button
                    type="submit"
                    disabled={isSearching}
                    className="rounded-2xl bg-[var(--ochre)] px-6 py-3 font-semibold text-[var(--ink)] transition hover:bg-[var(--ochre-dark)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSearching ? "Searching" : "Search"}
                  </button>
                </form>

                <div className="mt-6 flex flex-col gap-4">
                  {searchResults.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[var(--line)] p-8 text-center text-[var(--muted)]">
                      Search results will appear here with source, page, and similarity.
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-[var(--muted)]">
                          Passages matched for “{searchQuery.trim()}”
                        </p>
                        <button
                          type="button"
                          disabled={isChatting || !searchQuery.trim()}
                          onClick={() =>
                            void sendChatMessage(
                              `${searchQuery.trim()}\n\nGive a clear verdict from the Mahabharata/Gita evidence, with key encounters and who had the upper hand.`,
                            )
                          }
                          className="rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Answer this in Chat
                        </button>
                      </div>
                      {searchResults.map((result) => (
                      <article
                        key={result.id}
                        className="rounded-2xl border border-[var(--line)] bg-white p-5"
                      >
                        <div className="flex flex-wrap gap-2 text-sm text-[var(--muted)]">
                          <span className="font-semibold text-[var(--ink)]">
                            {sourceLabel(result.source)}
                          </span>
                          {result.page ? <span>Page {result.page}</span> : null}
                          <span>{formatPercent(result.similarity)} match</span>
                        </div>
                        {result.heading ? (
                          <h2 className="mt-3 font-serif text-2xl font-semibold text-[var(--ink)]">
                            {result.heading}
                          </h2>
                        ) : null}
                        <p className="mt-3 text-base leading-8 text-[var(--muted)]">
                          {result.content}
                        </p>
                      </article>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[30rem] flex-col">
                <div className="flex-1 space-y-4">
                  {chatMessages.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[var(--line)] p-8 text-center text-[var(--muted)]">
                      Ask a question and the answer will stream in with sources beneath it.
                    </div>
                  ) : (
                    chatMessages.map((message, index) => {
                      const isLastAssistant =
                        message.role === "assistant" &&
                        index === chatMessages.length - 1 &&
                        Boolean(message.content) &&
                        !isChatting;

                      return (
                      <article
                        key={message.id}
                        className={`rounded-2xl p-5 ${
                          message.role === "user"
                            ? "ml-auto max-w-2xl bg-[var(--ink)] text-white"
                            : "mr-auto max-w-3xl border border-[var(--line)] bg-white text-[var(--ink)]"
                        }`}
                      >
                        {message.role === "assistant" ? (
                          <SceneFrame scene={message.scene} status={message.sceneStatus} />
                        ) : null}
                        <p className="whitespace-pre-wrap leading-8">
                          {message.content || "Reading the passages..."}
                        </p>
                        {message.sources?.length ? (
                          <details className="mt-4 rounded-xl bg-[var(--mist)] p-4 text-[var(--ink)]">
                            <summary className="cursor-pointer font-semibold">
                              Sources ({message.sources.length})
                            </summary>
                            <div className="mt-3 space-y-3">
                              {message.sources.map((sourceItem) => (
                                <div key={sourceItem.id} className="text-sm leading-6 text-[var(--muted)]">
                                  <span className="font-semibold text-[var(--ink)]">
                                    {sourceLabel(sourceItem.source)}
                                  </span>
                                  {sourceItem.page ? `, page ${sourceItem.page}` : ""}
                                  {sourceItem.heading ? `, ${sourceItem.heading}` : ""}{" "}
                                  <span>({formatPercent(sourceItem.similarity)} match)</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {isLastAssistant ? (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {FOLLOW_UP_PROMPTS.map((prompt) => (
                              <button
                                key={prompt.label}
                                type="button"
                                disabled={isChatting}
                                onClick={() => void sendChatMessage(prompt.message)}
                                className="rounded-full border border-[var(--line)] bg-[var(--mist)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition hover:border-[var(--ochre)] disabled:opacity-50"
                              >
                                {prompt.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </article>
                      );
                    })
                  )}
                </div>

                <form onSubmit={handleChat} className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <input
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Ask a question about the epics"
                    className="min-h-12 flex-1 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 outline-none transition placeholder:text-[var(--muted)]/70 focus:border-[var(--ochre)] focus:ring-4 focus:ring-[var(--ochre-soft)]"
                  />
                  <button
                    type="submit"
                    disabled={isChatting}
                    className="rounded-2xl bg-[var(--ochre)] px-6 py-3 font-semibold text-[var(--ink)] transition hover:bg-[var(--ochre-dark)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isChatting ? "Streaming" : "Send"}
                  </button>
                </form>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}
