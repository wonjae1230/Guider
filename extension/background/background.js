// 툴바 아이콘 클릭 시 사이드패널이 열리도록 설정 (side_panel API 필수 설정)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
