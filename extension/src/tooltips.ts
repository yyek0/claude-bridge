export function installTooltips(tooltip: HTMLElement): () => void {
  let hovered: HTMLElement | undefined
  let focused: HTMLElement | undefined
  let described: HTMLElement | undefined

  const anchor = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') ?? undefined : undefined

  function refresh() {
    const source = hovered?.isConnected ? hovered : focused?.isConnected ? focused : undefined
    const rect = source?.getBoundingClientRect()
    const disabled = source?.querySelector(':disabled')
    const text = disabled ? source?.dataset.tooltipDisabled : source?.dataset.tooltip
    const visible = !!rect?.width && !!rect.height && !!text
    const active = document.activeElement
    const nextDescription = visible && source === focused && active instanceof HTMLElement ? active : undefined
    if (described !== nextDescription) {
      described?.removeAttribute('aria-describedby')
      nextDescription?.setAttribute('aria-describedby', tooltip.id)
      described = nextDescription
    }
    tooltip.hidden = !visible
    if (!visible) {
      return
    }
    tooltip.textContent = text
    const offset = 6
    const left = rect.left + (rect.width - tooltip.offsetWidth) / 2
    const above = rect.top - offset - tooltip.offsetHeight
    const top = above >= offset ? above : rect.bottom + offset
    tooltip.style.left = Math.max(offset, Math.min(left, window.innerWidth - tooltip.offsetWidth - offset)) + 'px'
    tooltip.style.top = Math.max(offset, Math.min(top, window.innerHeight - tooltip.offsetHeight - offset)) + 'px'
  }

  function dismiss() {
    hovered = undefined
    focused = undefined
    refresh()
  }

  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') {
      return
    }
    hovered = anchor(event.target)
    refresh()
  })
  document.addEventListener('pointerout', event => {
    if (event.pointerType !== 'touch' && anchor(event.target) !== anchor(event.relatedTarget)) {
      hovered = anchor(event.relatedTarget)
      refresh()
    }
  })
  document.addEventListener('focusin', event => {
    focused = anchor(event.target)
    refresh()
  })
  document.addEventListener('focusout', event => {
    focused = anchor(event.relatedTarget)
    refresh()
  })
  document.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      dismiss()
    }
  })
  window.addEventListener('resize', refresh)
  window.addEventListener('scroll', refresh, true)
  return refresh
}
