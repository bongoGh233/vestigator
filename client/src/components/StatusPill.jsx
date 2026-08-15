export default function StatusPill({ status }) {
  const live = status === "in_transit" || status === "online";
  return (
    <span className={`pill ${status}`}>
      {live && <span className="pulse" />}
      {status.replace("_", " ")}
    </span>
  );
}
