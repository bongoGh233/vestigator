import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import { fmtDateTime } from "../utils";

const TYPE_ICONS = {
  BOOKING_REQUEST_RECEIVED: "\uD83D\uDCE5",
  BOOKING_ACCEPTED: "\u2705",
  BOOKING_REJECTED: "\u274C",
  BOOKING_EN_ROUTE: "\uD83D\uDE97",
  BOOKING_ARRIVED: "\uD83D\uDCCD",
  BOOKING_SERVICE_STARTED: "\u2699\uFE0F",
  BOOKING_COMPLETED: "\uD83C\uDF1F",
  BOOKING_CANCELLED: "\u26A0\uFE0F",
  BOOKING_EXPIRED: "\u23F0",
  MESSAGE_NEW: "\uD83D\uDCAC",
  REVIEW_RECEIVED: "\u2B50",
};

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  const loadNotifications = useCallback(async () => {
    try {
      const data = await api("/api/notifications?limit=20");
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  useEffect(() => {
    function handleNew(n) {
      setNotifications((prev) => [n, ...prev].slice(0, 20));
      setUnreadCount((c) => c + 1);
    }
    socket.on("notification:new", handleNew);
    return () => socket.off("notification:new", handleNew);
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function handleClick(n) {
    if (!n.readAt) {
      try {
        await api(`/api/notifications/${n.id}/read`, { method: "POST" });
        setNotifications((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch { /* ignore */ }
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  async function markAllRead() {
    try {
      await api("/api/notifications/read-all", { method: "POST" });
      setNotifications((prev) => prev.map((x) => ({ ...x, readAt: x.readAt || Date.now() })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  }

  return (
    <div className="notification-bell-wrap" ref={dropdownRef}>
      <button
        className="notification-bell-btn"
        onClick={() => { setOpen(!open); setLoading(false); }}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <span className="notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>

      {open && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <span className="notification-title">Notifications</span>
            {unreadCount > 0 && (
              <button className="notification-mark-all" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>
          <div className="notification-list">
            {notifications.length === 0 && (
              <div className="notification-empty">No notifications yet</div>
            )}
            {notifications.map((n) => (
              <button
                key={n.id}
                className={`notification-item${n.readAt ? "" : " unread"}`}
                onClick={() => handleClick(n)}
              >
                <span className="notification-icon">{TYPE_ICONS[n.type] || "\uD83D\uDD14"}</span>
                <div className="notification-content">
                  <div className="notification-item-title">{n.title}</div>
                  <div className="notification-item-body">{n.body}</div>
                  <div className="notification-item-time">{fmtDateTime(n.createdAt)}</div>
                </div>
                {!n.readAt && <span className="notification-dot" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
