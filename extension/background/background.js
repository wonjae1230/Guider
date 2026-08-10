// 툴바 아이콘 클릭 시 사이드패널이 열리도록 설정 (side_panel API 필수 설정)
// manifest.json에 "sidePanel" permission이 없으면 chrome.sidePanel 자체가
// undefined이므로, 없는 환경에서 서비스워커가 죽지 않도록 가드합니다.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
