import { useEffect, useState, useRef, useCallback } from "react";
import { socket } from "../socket";
import { api } from "../api";
import { useAuth } from "../auth";
import { fmtTime } from "../utils";

const PAGE_LIMIT = 50;
const TERMINAL = new Set(["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"]);
const LEGACY_ENDED = new Set(["arrived", "cancelled"]);

export default function ChatPanel({ bookingId, bookingStatus, peerName }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef(null);
  const listRef = useRef(null);
  const userRef = useRef(user);
  userRef.current = user;

  const terminal = TERMINAL.has(bookingStatus) || LEGACY_ENDED.has(bookingStatus);
  const canSend = !terminal && !sending;

  const scrollToBottom = useCallback((smooth) => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: smooth ? "smooth" : "instant" });
    }
  }, []);

  // Load initial messages
  useEffect(() => {
    if (!bookingId) return;
    setMessages([]);
    setHasMore(true);
    setLoading(true);
    api(`/api/bookings/${bookingId}/messages?limit=${PAGE_LIMIT}`)
      .then((data) => {
        setMessages(data || []);
        setHasMore((data || []).length >= PAGE_LIMIT);
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setTimeout(() => scrollToBottom(false), 50);
      });
  }, [bookingId, scrollToBottom]);

  // Load older messages
  function loadOlder() {
    if (!hasMore || loading) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoading(true);
    api(`/api/bookings/${bookingId}/messages?before=${oldest.id}&limit=${PAGE_LIMIT}`)
      .then((older) => {
        if (!older || older.length === 0) {
          setHasMore(false);
          return;
        }
        const prevScrollHeight = listRef.current?.scrollHeight || 0;
        setMessages((prev) => [...older, ...prev]);
        setHasMore(older.length >= PAGE_LIMIT);
        requestAnimationFrame(() => {
          if (listRef.current) {
            listRef.current.scrollTop += listRef.current.scrollHeight - prevScrollHeight;
          }
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  // Socket.IO listeners
  useEffect(() => {
    function onNew({ bookingId: bid, message }) {
      if (bid !== bookingId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, message];
      });
      setTimeout(() => scrollToBottom(true), 50);
    }

    function onRead({ bookingId: bid, readerId }) {
      if (bid !== bookingId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.senderId !== userRef.current?.id && !m.readAt) {
            return { ...m, readAt: Date.now() };
          }
          return m;
        })
      );
    }

    socket.on("message:new", onNew);
    socket.on("message:read", onRead);
    return () => {
      socket.off("message:new", onNew);
      socket.off("message:read", onRead);
    };
  }, [bookingId, scrollToBottom]);

  // Mark messages as read when they arrive
  useEffect(() => {
    if (!bookingId || messages.length === 0) return;
    const unread = messages.some((m) => m.senderId !== user?.id && !m.readAt);
    if (unread) {
      api(`/api/bookings/${bookingId}/messages/read`, { method: "POST" }).catch(() => {});
    }
  }, [bookingId, messages, user]);

  async function send() {
    const text = body.trim();
    if (!text || !canSend) return;
    setSending(true);
    setError("");
    try {
      await api(`/api/bookings/${bookingId}/messages`, {
        method: "POST",
        body: { body: text },
      });
      setBody("");
    } catch (err) {
      setError(err.message || "Could not send message.");
    } finally {
      setSending(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h3 style={{ margin: 0, fontSize: 15 }}>Messages</h3>
        {peerName && <span className="sub">{peerName}</span>}
      </div>

      <div className="chat-list" ref={listRef}>
        {hasMore && (
          <button className="chat-load-more" onClick={loadOlder} disabled={loading}>
            {loading ? "Loading…" : "Load older messages"}
          </button>
        )}
        {!hasMore && messages.length > 0 && (
          <div className="chat-divider">Beginning of conversation</div>
        )}
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            {terminal
              ? "No messages were sent for this booking."
              : "No messages yet. Send the first one!"}
          </div>
        )}
        {messages.map((m) => {
          const mine = m.senderId === user?.id;
          return (
            <div key={m.id} className={`chat-msg${mine ? " mine" : ""}`}>
              <div className="chat-bubble">
                {!mine && m.sender?.name && (
                  <div className="chat-sender">{m.sender.name}</div>
                )}
                <div className="chat-text">{m.body}</div>
                <div className="chat-meta">
                  <span className="chat-time">{fmtTime(m.createdAt)}</span>
                  {mine && <span className="chat-read">{m.readAt ? "✓✓" : "✓"}</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {terminal ? (
        <div className="chat-terminated">
          Messaging is no longer available for this booking.
        </div>
      ) : (
        <div className="chat-input">
          <textarea
            className="chat-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a message…"
            maxLength={2000}
            rows={1}
            disabled={sending}
          />
          <div className="chat-input-foot">
            <span className="sub">{body.length}/2000</span>
            <button
              className="btn"
              disabled={!body.trim() || !canSend}
              onClick={send}
            >
              {sending ? "…" : "Send"}
            </button>
          </div>
          {error && (
            <p className="help" style={{ color: "var(--danger)", margin: "4px 0 0" }}>{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
