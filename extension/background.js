chrome.action.onClicked.addListener(async tab => {
  const isFile = tab.id && /^https:\/\/www\.figma\.com\/(design|file)\/[^/]+/.test(tab.url || '');
  const fileKey = isFile ? new URL(tab.url).pathname.split('/')[2] : null;
  const page = isFile ? `connect.html?tab=${tab.id}&file=${encodeURIComponent(fileKey)}` : 'connect.html?error=not-file';
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Не удалось открыть подключение. Перезагрузи расширение и попробуй снова.' });
  }
});
