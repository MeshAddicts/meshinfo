export function getDetailsDom() {
  const nodePanel = document.getElementById("details");
  const nodeTitle = document.getElementById("details-title");
  const nodeSubtitle = document.getElementById("details-subtitle");
  const nodeContent = document.getElementById("details-content");

  return { nodePanel, nodeTitle, nodeSubtitle, nodeContent };
}

export function clearDetailsPanel() {
  const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
  if (!nodePanel || !nodeTitle || !nodeSubtitle || !nodeContent) return;

  nodeTitle.textContent = "";
  nodeSubtitle.textContent = "";
  nodeContent.innerHTML = "";

  nodePanel.classList.add("hidden");
}

export function setDetailsPanelContent(opts: {
  title: string;
  subtitle: string;
  html: string;
}) {
  const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
  if (!nodePanel || !nodeTitle || !nodeSubtitle || !nodeContent) return;

  nodeTitle.textContent = opts.title;
  nodeSubtitle.textContent = opts.subtitle;
  nodeContent.innerHTML = opts.html;

  nodePanel.classList.remove("hidden");
}
