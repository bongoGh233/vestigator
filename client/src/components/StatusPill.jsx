const LABELS = {
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  PROVIDER_EN_ROUTE: "Provider en route",
  ARRIVED: "Arrived",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export default function StatusPill({ status }) {
  const live =
    status === "in_transit" ||
    status === "online" ||
    status === "PROVIDER_EN_ROUTE" ||
    status === "ARRIVED" ||
    status === "IN_PROGRESS";
  return (
    <span className={`pill ${String(status || "").toLowerCase()}`}>
      {live && <span className="pulse" />}
      {LABELS[status] || String(status || "").replace("_", " ")}
    </span>
  );
}
