import { useCallback, useRef } from "react";

const DRAG_THRESHOLD = 4;
const EDGE_MARGIN = 8;

// 카드↔런처 전환으로 크기가 바뀌어 고정된 우하단 모서리 기준으로 펼쳐질 때
// 반대쪽(위/왼쪽)이 화면 밖으로 넘어가지 않도록 bottom/right 값을 보정한다.
export function clampIntoViewport(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const computed = window.getComputedStyle(el);
  const currentBottom = parseFloat(computed.bottom) || 0;
  const currentRight = parseFloat(computed.right) || 0;

  if (rect.top < EDGE_MARGIN) {
    const overflowTop = EDGE_MARGIN - rect.top;
    el.style.bottom = `${Math.max(currentBottom - overflowTop, EDGE_MARGIN)}px`;
  }
  if (rect.left < EDGE_MARGIN) {
    const overflowLeft = EDGE_MARGIN - rect.left;
    el.style.right = `${Math.max(currentRight - overflowLeft, EDGE_MARGIN)}px`;
  }
}

// targetRef가 가리키는 요소(고정 위치 컨테이너)를 드래그로 이동시킨다.
// 반환된 핸들러들은 드래그 손잡이 역할을 할 요소(헤더, 런처 버튼 등)에 붙인다.
export function useDraggable(targetRef) {
  const dragRef = useRef({
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    startRight: 0,
    startBottom: 0,
  });

  const onPointerDown = useCallback(
    (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // 손잡이(헤더/런처) 안에 중첩된 버튼 등 실제 컨트롤을 누른 경우는
      // 드래그를 시작하지 않고 클릭이 그대로 전달되도록 둔다. 손잡이 자체가
      // button/[role=button]인 경우(런처)는 제외 대상이 아니다.
      if (e.target !== e.currentTarget) {
        const interactive = e.target.closest?.(
          'button, a, input, textarea, select, [role="button"]',
        );
        if (interactive && interactive !== e.currentTarget) {
          return;
        }
      }
      const el = targetRef.current;
      if (!el) return;

      // 오른쪽/아래 모서리를 기준점으로 고정한다. 카드↔런처 전환 시 크기가
      // 바뀌어도 이 모서리가 고정되어 항상 좌상단(북서쪽)으로 펼쳐진다.
      const rect = el.getBoundingClientRect();
      const startRight = window.innerWidth - rect.right;
      const startBottom = window.innerHeight - rect.bottom;
      el.style.right = `${startRight}px`;
      el.style.bottom = `${startBottom}px`;
      el.style.left = "auto";
      el.style.top = "auto";

      dragRef.current = {
        dragging: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        startRight,
        startBottom,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [targetRef],
  );

  const onPointerMove = useCallback(
    (e) => {
      const state = dragRef.current;
      if (!state.dragging) return;
      const el = targetRef.current;
      if (!el) return;

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (
        !state.moved &&
        (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
      ) {
        state.moved = true;
      }
      if (!state.moved) return;

      const maxRight = window.innerWidth - el.offsetWidth - EDGE_MARGIN;
      const maxBottom = window.innerHeight - el.offsetHeight - EDGE_MARGIN;
      const right = Math.min(
        Math.max(state.startRight - dx, EDGE_MARGIN),
        Math.max(maxRight, EDGE_MARGIN),
      );
      const bottom = Math.min(
        Math.max(state.startBottom - dy, EDGE_MARGIN),
        Math.max(maxBottom, EDGE_MARGIN),
      );
      el.style.right = `${right}px`;
      el.style.bottom = `${bottom}px`;
    },
    [targetRef],
  );

  const onPointerUp = useCallback((e) => {
    dragRef.current.dragging = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // 드래그 후 클릭이 브라우저에 의해 억제되어 onClickCapture가 실행되지 않는
    // 경우를 대비해, click 처리가 끝났을 다음 태스크에서 moved 플래그를 정리한다.
    setTimeout(() => {
      dragRef.current.moved = false;
    }, 0);
  }, []);

  const onPointerCancel = useCallback(() => {
    dragRef.current.dragging = false;
  }, []);

  // 드래그 직후 발생하는 클릭(예: 런처 버튼 열기)이 오작동하지 않도록 막는다.
  const onClickCapture = useCallback((e) => {
    if (dragRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.moved = false;
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  };
}
