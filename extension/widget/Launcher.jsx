import logo from "../assets/icons/icon128.png";

function Launcher({ onClick, dragHandleProps }) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className="gd-launcher"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label="Guider 열기"
      {...dragHandleProps}
    >
      <img src={logo} alt="" draggable="false" />
    </div>
  );
}

export default Launcher;
