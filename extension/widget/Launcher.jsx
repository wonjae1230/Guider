import logo from "../assets/icons/icon128.png";

function Launcher({ onClick }) {
  return (
    <button
      type="button"
      className="gd-launcher"
      onClick={onClick}
      aria-label="Guider 열기"
    >
      <img src={logo} alt="" />
    </button>
  );
}

export default Launcher;
