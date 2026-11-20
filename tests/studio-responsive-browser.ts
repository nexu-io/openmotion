// Run after build:studio with node --experimental-strip-types --test tests/studio-responsive-browser.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer, { type Page } from 'puppeteer-core';
import { browserExecutable } from '../browser.ts';
import { designProjectsFor } from '../design-projects.ts';
import { gatewayFor } from '../gateway/service.ts';
import { startServer } from '../server.ts';
import { designRoutes } from '../shared/design-project.ts';
import { fixture } from './fixtures.ts';

async function checkDesignComposerAlignment(page: Page) {
  await page.waitForFunction(() => {
    const gallery = document.querySelector('.om-design-page-with-dock > section')?.getBoundingClientRect();
    const composer = document.querySelector('.om-design-bottom-composer')?.getBoundingClientRect();
    return gallery && composer && Math.abs(gallery.left - composer.left) <= 1 && Math.abs(gallery.right - composer.right) <= 1;
  }, { timeout: 5000 });
}

async function checkCreator(page: Page, stacked: boolean) {
  const geometry = await page.$eval('.om-creator-pane', pane => {
    const button = pane.querySelector<HTMLButtonElement>('.om-asset-direct > button.om-button')!;
    const range = document.createRange();
    range.selectNodeContents(button);
    const bounds = button.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(button).paddingInline);
    const lines = Array.from(range.getClientRects());
    const [provider, model] = Array.from(pane.querySelectorAll('.om-generation-picker [role="combobox"]'), el => el.getBoundingClientRect());
    return {
      textFits: lines.length > 0 && lines.every(line => line.left >= bounds.left + padding - 1 && line.right <= bounds.right - padding + 1 && line.top >= bounds.top && line.bottom <= bounds.bottom),
      stacked: model.top >= provider.bottom && Math.abs(model.left - provider.left) < 1,
      aligned: model.left >= provider.right && Math.abs(model.bottom - provider.bottom) < 1,
    };
  });
  assert.ok(geometry.textFits, 'Every line of the provider setup action fits inside the button');
  assert.ok(stacked ? geometry.stacked : geometry.aligned, 'The model controls respond to the width of the creator pane');
}

test('Explore is home and project navigation stays in the workspace', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('motion.studio.locale', 'en');
        localStorage.setItem('motion.workspace.navigation.v1', 'collapsed');
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
      });
      const origin = (await running.info()).previewUrl;
      await page.goto(new URL('/', origin).href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.om-explore-host:not([hidden])');
      assert.equal(new URL(page.url()).searchParams.get('project'), null);
      for (const [width, theme] of [[1440, 'light'], [390, 'dark']] as const) {
        await page.setViewport({ width, height: 800 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.waitForFunction(theme => (document.documentElement.dataset.theme === 'paper') === (theme === 'light'), {}, theme);
        assert.equal(await page.$('.om-project-navigation'), null);
        const trigger = await page.waitForSelector('.om-app-header-actions .om-account-trigger', { visible: true });
        const anchor = (await trigger!.boundingBox())!;
        assert.ok(anchor.x + anchor.width <= width && anchor.x > width - 80);
        await trigger!.click();
        const popup = await page.waitForSelector('.om-account-menu', { visible: true });
        const bounds = (await popup!.boundingBox())!;
        assert.ok(bounds.y >= anchor.y + anchor.height - 1 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.keyboard.press('Escape');
        await page.waitForSelector('.om-account-menu', { hidden: true });
        const galleryTitleStyles = [];
        for (const [name, closeSelector, titleSelector] of [
          ['Templates', '[data-workspace-gallery] button[aria-label="Close template library"]', '[data-workspace-gallery] .om-gallery-page-label'],
          ['Skills', '.om-skills-heading-actions button[aria-label="Close"]', '.om-skills-intro h1'],
        ]) {
          const shortcut = await page.waitForSelector(`.om-explore-nav ::-p-text(${name})`, { visible: true });
          const shortcutBounds = (await shortcut!.boundingBox())!;
          assert.ok(shortcutBounds.x >= 0 && shortcutBounds.x + shortcutBounds.width <= width);
          assert.equal(await shortcut!.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
          await shortcut!.focus();
          await page.keyboard.press('Enter');
          const close = await page.waitForSelector(closeSelector, { visible: true });
          if (name === 'Templates') assert.equal(await page.$('[data-workspace-gallery] .om-gallery-header-actions a[href*="github.com"]'), null);
          galleryTitleStyles.push(await page.$eval(titleSelector, element => {
            const { color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight } = getComputedStyle(element);
            return { color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight };
          }));
          const closeBounds = (await close!.boundingBox())!;
          assert.ok(closeBounds.x >= 0 && closeBounds.x + closeBounds.width <= width);
          await close!.focus();
          await page.keyboard.press('Enter');
          await page.waitForSelector('.om-explore-nav', { visible: true });
          assert.ok(await shortcut!.evaluate(element => element === document.activeElement));
        }
        assert.deepEqual(galleryTitleStyles[0], galleryTitleStyles[1]);
      }
      await page.setViewport({ width: 1440, height: 800 });
      await page.click('.om-app-header [aria-label="Motion Studio"]');
      await page.waitForSelector('main[aria-label="Motion templates"]', { visible: true });
      const project = await page.waitForSelector('.om-project-navigation:not([inert]) button.motion-session', { visible: true });
      await project!.click();
      await page.waitForSelector('.motion-timeline-icon-controls', { visible: true });
      await page.waitForSelector('.om-project-navigation:not([inert])', { visible: true });
      const editorUrl = page.url();
      await page.click('.om-app-brand');
      await page.waitForSelector('.om-explore-host:not([hidden])');
      assert.equal(await page.$('.om-project-navigation'), null);
      await page.goBack();
      await page.waitForSelector('.motion-timeline-icon-controls', { visible: true });
      assert.equal(new URL(page.url()).searchParams.get('project'), new URL(editorUrl).searchParams.get('project'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.motion-timeline-icon-controls', { visible: true });
      assert.ok(await page.waitForSelector('.om-project-navigation:not([inert])', { visible: true }));
    } finally { await browser.close(); await running.close(); }
  });
});

test('Design Studio uses the same navigation styles and overflow controls across scenes', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('motion.studio.locale', 'en');
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
      });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setViewport({ width: 1800, height: 900 });
      const origin = (await running.info()).previewUrl;
      await page.goto(new URL('/?page=design&scene=image-edit', origin).href, { waitUntil: 'domcontentloaded' });

      const track = '.om-design-scene-tabs-track';
      const viewport = '.om-design-scene-tabs-viewport';
      const active = `${track} > button[aria-current="page"]`;
      const imageEditing = `${track} ::-p-text(Image editing)`;
      const prototype = `${track} ::-p-text(Prototype)`;
      const previous = '.om-design-scene-tabs [data-edge="left"]';
      const next = '.om-design-scene-tabs [data-edge="right"]';
      const style = (selector: string) => page.$eval(selector, async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished));
        const { color, backgroundColor, fontSize, fontWeight } = getComputedStyle(element);
        return { color, backgroundColor, fontSize, fontWeight };
      });
      const arrowSurface = (selector: string) => page.$eval(selector, element => {
        const { backgroundColor, borderTopWidth, boxShadow } = getComputedStyle(element);
        return [backgroundColor, borderTopWidth, boxShadow];
      });
      const headingIconStyle = () => page.$eval('.om-studio-bar h1 > [data-tone="image"]', icon => {
        const { backgroundColor, borderRadius, color, height, width } = getComputedStyle(icon);
        return { backgroundColor, borderRadius, color, height, width };
      });
      const transparentArrow = ['rgba(0, 0, 0, 0)', '0px', 'none'];

      await page.waitForSelector(active, { visible: true });
      assert.equal(await page.$eval(active, button => button.textContent), 'Image editing');
      const imageHeadingIcon = await headingIconStyle();
      await page.locator('.om-creative-navigation ::-p-aria([name="Image"][role="button"])').click();
      await page.waitForFunction(() => {
        const route = new URLSearchParams(location.search);
        return route.get('page') === 'create' && route.get('scene') === 'image-edit';
      });
      await page.waitForSelector('.om-studio-bar ::-p-text(Open in Design Studio)', { visible: true });
      assert.equal(await page.$(track), null);
      assert.equal(await page.$('#om-design-project-navigation'), null);
      await page.click('.om-creative-navigation [data-nav-slot]:not([data-stowed]) > button[aria-label="Design Studio"]');
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Text to image', {}, active);
      assert.equal(new URL(page.url()).searchParams.get('page'), 'design');
      assert.deepEqual(await headingIconStyle(), imageHeadingIcon);
      assert.deepEqual(await page.$$eval(`${track} > button`, buttons =>
        [...new Set(buttons.map(button => getComputedStyle(button).fontSize))]), ['12px']);
      assert.equal(await page.$(next), null);
      const imageSelected = await style(active);
      const defaultStyle = await style(imageEditing);
      assert.equal(await page.$(`${track} ::-p-text(Projects)`), null);
      assert.deepEqual(await style(prototype), defaultStyle);
      await page.hover(imageEditing);
      const imageHover = await style(imageEditing);
      assert.notEqual(imageHover.backgroundColor, defaultStyle.backgroundColor);
      await page.hover(prototype);
      assert.deepEqual(await style(prototype), imageHover);
      await page.click(prototype);
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Prototype', {}, active);
      assert.equal(await page.$('.om-studio-bar ::-p-text(Explore)'), null);
      assert.notEqual(imageHeadingIcon.backgroundColor, 'rgba(0, 0, 0, 0)');
      assert.deepEqual(await headingIconStyle(), imageHeadingIcon);
      assert.deepEqual(await style(active), imageSelected);
      const galleryHeader = '.om-design-page-with-dock > section:first-child > .om-design-section-head';
      await page.waitForSelector(galleryHeader, { visible: true });
      assert.equal(await page.$eval(`${galleryHeader} h2`, title => title.textContent), 'Prototype templates');
      await checkDesignComposerAlignment(page);
      assert.ok(await page.$eval(galleryHeader, header => {
        const { top, bottom } = header.querySelector('h2')!.getBoundingClientRect();
        return Array.from(header.querySelectorAll('input, button')).every(control => {
          const { y, height } = control.getBoundingClientRect();
          const center = y + height / 2;
          return center >= top && center <= bottom;
        });
      }));

      await page.setViewport({ width: 860, height: 900 });
      const nextArrow = await page.waitForSelector(next, { visible: true });
      await nextArrow!.hover();
      assert.deepEqual(await arrowSurface(next), transparentArrow);
      await nextArrow!.click();
      await page.waitForFunction(selector => document.querySelector(selector)!.scrollLeft > 0, {}, viewport);
      const previousArrow = await page.waitForSelector(previous, { visible: true });
      await previousArrow!.click();
      await page.waitForFunction(selector => document.querySelector(selector)!.scrollLeft === 0, {}, viewport);

      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setViewport({ width: 390, height: 800 });
      await page.goto(new URL('/?page=design&scene=webgl', origin).href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(next, { visible: true });
      assert.equal(await page.$eval(`${galleryHeader} h2`, title => title.textContent), 'WebGL templates');
      await checkDesignComposerAlignment(page);
      assert.equal(await page.$eval(active, button => button.textContent), 'WebGL');
      assert.equal(await page.$eval(viewport, rail => rail.scrollLeft), 0);
      assert.equal(await page.$(previous), null);
      assert.ok(await page.$eval(`${track} > button:first-child`, button => {
        const tab = button.getBoundingClientRect();
        const strip = button.closest('.om-design-scene-tabs-viewport')!.getBoundingClientRect();
        return button.textContent === 'Text to image' && tab.left >= strip.left && tab.right <= strip.right;
      }));
      await page.goto(new URL('/?page=design', origin).href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(next, { visible: true });
      assert.equal(await page.$eval(active, button => button.textContent), 'Text to image');
      assert.equal(await page.$eval(viewport, rail => rail.scrollLeft), 0);
    } finally { await browser.close(); await running.close(); }
  });
});

test('Design Studio dismisses mention suggestions on an outside press', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
      });
      const origin = (await running.info()).previewUrl;
      const input = '.om-design-bottom-input';
      const menu = '.om-design-mention-menu';
      const filter = '.om-design-page-with-dock input[type="search"]';
      const prompt = `${menu} [data-kind="prompt"]`;
      const draft = 'Make a mobile app @';

      for (const [theme, width] of [['dark', 1400], ['light', 480]] as const) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.setViewport({ width, height: 900 });
        await page.goto(new URL('/?page=design&scene=mobile-app', origin).href, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(input, { visible: true });
        await page.type(input, draft);
        await page.waitForSelector(menu, { visible: true });

        await page.click(filter);
        await page.waitForSelector(menu, { hidden: true, timeout: 2500 });
        assert.equal(await page.$eval(input, field => (field as HTMLTextAreaElement).value), draft);
        assert.equal(await page.$eval(filter, field => field === document.activeElement), true);

        await page.focus(input);
        await page.keyboard.press('End');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('@');
        const firstPrompt = await page.waitForSelector(prompt, { visible: true });
        const label = await firstPrompt!.$eval('.om-design-mention-label', element => element.textContent);
        await firstPrompt!.click();
        await page.waitForSelector(menu, { hidden: true });
        assert.equal(await page.$eval(input, field => (field as HTMLTextAreaElement).value), `Make a mobile app ${label} `);
      }
    } finally { await browser.close(); await running.close(); }
  });
});

test('Design Studio copies template briefs in place and creates projects separately', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('motion.studio.locale', 'zh-CN');
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
        navigator.clipboard.writeText = async text => { document.documentElement.dataset.copiedBrief = text; };
      });
      const origin = (await running.info()).previewUrl;
      const scene = new URL('/?page=design&scene=prototype', origin).href;
      const explore = new URL('/?page=explore', origin).href;
      const card = '.om-design-gallery-card';
      const quickAction = `${card} .om-design-gallery-body > .om-design-gallery-action`;
      const recent = '.om-design-page-with-dock > section + section';
      const popup = '.om-design-tpl-detail-popup';
      const primary = `${popup} .om-media-detail-action-row > button[data-primary]`;
      const remix = `${popup} button[aria-label="复用为项目"]`;
      const feedback = `${popup} [data-feedback-layer]`;
      const creates: string[] = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/motion-api/design/projects') {
          creates.push(request.postData() ?? '');
        }
      });

      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await page.setViewport({ width: 1400, height: 900 });
      await page.goto(scene, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(quickAction, { visible: true });
      assert.equal(await page.$(recent), null);
      await page.hover(card);
      assert.deepEqual(await page.$eval(`${card} .om-design-gallery-body`, actions =>
        [...actions.querySelectorAll(':scope > button')].map(button => button.textContent)), ['复刻模版']);
      assert.ok(await page.$eval(card, template => {
        const thumb = template.querySelector('.om-design-card-thumb')!.getBoundingClientRect();
        const description = template.querySelector('.om-design-card-desc')!;
        const action = template.querySelector('.om-design-gallery-action')!.getBoundingClientRect();
        const style = getComputedStyle(description);
        return style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis'
          && action.top >= thumb.bottom && action.left >= description.getBoundingClientRect().right;
      }));
      await page.click(quickAction);
      await page.waitForFunction(() => document.documentElement.dataset.copiedBrief?.includes('velar-luxury-real-estate'));
      assert.equal(await page.$(popup), null);
      assert.equal(creates.length, 0);

      for (const [theme, width] of [['dark', 1400], ['light', 600]] as const) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.setViewport({ width, height: 900 });
        await page.goto(scene, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`${card} .om-design-card-title`, { visible: true });
        await page.click(`${card} .om-design-card-title`);
        await page.waitForSelector(primary, { visible: true });
        assert.equal(await page.$eval(primary, button => button.textContent), '复刻模版');
        assert.ok(await page.$(`${primary} .motion-icon path`));
        assert.ok(await page.$(`${remix} [data-remix-icon="folder-add-line"] path`));
        const { primaryRect, remixRect, remixWidth } = await page.$eval(popup, (dialog, primarySelector, remixSelector) => {
          const primaryButton = dialog.querySelector(primarySelector)!;
          const remixButton = dialog.querySelector(remixSelector)!;
          return {
            primaryRect: primaryButton.getBoundingClientRect().toJSON(),
            remixRect: remixButton.getBoundingClientRect().toJSON(),
            remixWidth: getComputedStyle(remixButton).width,
          };
        }, primary, remix);
        assert.equal(remixRect.top, primaryRect.top);
        assert.equal(remixRect.height, primaryRect.height);
        assert.equal(remixWidth, '40px');
        assert.ok(remixRect.left > primaryRect.right);

        const preview = await page.$(`${popup} iframe.om-design-iframe`);
        await page.focus(primary);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.documentElement.dataset.copiedBrief?.includes('velar-luxury-real-estate'));
        const notice = await page.waitForSelector(`${feedback} [role="status"]`, { visible: true });
        assert.equal(await notice!.evaluate(element => element.textContent), '已复制，发给 Agent 即可。');
        assert.equal(await page.$eval(feedback, layer => !layer.closest('[aria-hidden="true"], [inert]')), true);
        assert.equal(await preview!.evaluate(element => element.isConnected), true);
        assert.equal(page.url(), scene);
        assert.equal(creates.length, 0);
      }

      await page.click(remix);
      await page.waitForFunction(() => new URLSearchParams(location.search).has('designProject'));
      assert.equal(creates.length, 1);
      assert.equal(JSON.parse(creates[0]).templateId, 'velar-luxury-real-estate');

      await page.goto(scene, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${recent} .om-design-card`, { visible: true });
      assert.equal(await page.$eval(`${recent} h2`, heading => heading.textContent), '最近项目');
      await page.click(`${recent} .om-design-section-head button`);
      await page.waitForFunction(() => new URLSearchParams(location.search).get('scene') === 'projects');

      const composer = '.om-design-bottom-composer';
      const fallback = '.om-design-bottom-dock-wrap textarea[readonly]';
      for (const [button, expectedText] of [
        [quickAction, 'velar-luxury-real-estate'],
        [`${composer} ::-p-text(复制给 Agent)`, 'A brief to copy manually'],
      ]) {
        await page.goto(scene, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(quickAction, { visible: true });
        await page.evaluate(() => {
          navigator.clipboard.writeText = async () => { throw new Error('Clipboard access denied'); };
        });
        await page.locator(`${composer} textarea`).fill('A brief to copy manually');
        await page.locator(button).click();
        const field = await page.waitForSelector(fallback, { visible: true, timeout: 5000 });
        assert.ok((await field!.evaluate(el => el.value)).includes(expectedText));
        await field!.click({ clickCount: 3 });
        assert.ok(await field!.evaluate(el => document.activeElement === el && el.selectionEnd > el.selectionStart),
          'The manual copy field must accept a pointer selection');
      }

      await page.goto(explore, { waitUntil: 'domcontentloaded' });
      const exploreTemplate = '[data-design-template="velar-luxury-real-estate"] .om-design-card-title';
      await page.waitForSelector(exploreTemplate, { visible: true });
      await page.click(exploreTemplate);
      await page.waitForSelector(primary, { visible: true });
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => { throw new Error('Clipboard access denied'); };
      });
      await page.click(primary);
      const errorNotice = await page.waitForSelector(`${feedback} [role="alert"]`, { visible: true });
      assert.equal(await errorNotice!.evaluate(element => element.textContent), '复制失败，请检查剪贴板权限后重试。');
      assert.equal(page.url(), explore);
    } finally { await browser.close(); await running.close(); }
  });
});

test('Design Studio opens projects from its collapsible sidebar', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const designProjects = designProjectsFor(store.directory);
    const project = await designProjects.create({
      requestId: 'design-sidebar-project', scenario: 'mobile-app', title: 'Mobile app project',
    });
    const prototype = await designProjects.create({
      requestId: 'design-sidebar-prototype', scenario: 'prototype', title: 'Prototype project',
    });
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.browserContext().setDownloadBehavior({ policy: 'allow', downloadPath: store.directory });
      await page.setViewport({ width: 1440, height: 800 });
      await page.evaluateOnNewDocument(() => localStorage.setItem('motion.studio.locale', 'en'));
      const origin = (await running.info()).previewUrl;
      await page.goto(new URL('/?page=design&scene=mobile-app', origin).href, { waitUntil: 'domcontentloaded' });

      const sidebar = '#om-design-project-navigation';
      const toggle = 'button[aria-controls="om-design-project-navigation"][aria-label="Open project list"]';
      const search = `${sidebar} input[type="search"]`;
      const row = `${sidebar} button[aria-label="Mobile app project"]`;
      const sidebarProject = `${sidebar} [data-design-project-row="${project.id}"]`;
      const galleryProject = `.om-design-card[data-design-project-row="${project.id}"]`;
      const recentProjects = '.om-design-page-with-dock > section + section';
      const category = `${sidebar} .om-design-project-search button[aria-label="Filters"]`;
      const galleryCategory = '.om-design-page .om-design-project-search button[aria-haspopup="menu"]';
      const categoryMenu = '[role="menu"][aria-label="Project category"]:not([data-ending-style])';
      const sidebarTrash = `${sidebar} button[aria-pressed]`;
      const actionPopup = '.om-design-project-menu:not([data-ending-style])';
      const openActions = async (rowSelector: string) => {
        if (rowSelector.startsWith(sidebar)) await page.locator(rowSelector).setTimeout(5000).hover();
        await page.locator(`${rowSelector} [data-project-actions]`).setTimeout(5000).click();
      };
      const selectAction = (name: string) => page.locator(`${actionPopup} ::-p-text(${name})`).setTimeout(5000).click();
      await page.waitForSelector(row, { visible: true });
      assert.equal(await page.$('.om-studio-bar nav ::-p-text(Projects)'), null);
      assert.equal(await page.$(`${sidebar} ::-p-text(All projects)`), null);

      const actionWrapper = `${sidebarProject} .om-disclosure-row-action`;
      assert.ok(await page.$(`${actionWrapper} [data-remix-icon="more-2-line"]`));
      const restColor = await page.$eval(sidebarProject, el => getComputedStyle(el).backgroundColor);
      assert.equal(await page.$eval(actionWrapper, el => getComputedStyle(el).opacity), '0');
      await page.hover(sidebarProject);
      await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)!).opacity === '1', {}, actionWrapper);
      assert.notEqual(await page.$eval(sidebarProject, el => getComputedStyle(el).backgroundColor), restColor);
      await page.mouse.move(800, 400);
      await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)!).opacity === '0', {}, actionWrapper);
      await page.focus(row);
      await page.keyboard.press('Tab');
      assert.ok(await page.$eval(actionWrapper, el => el.contains(document.activeElement)));
      await page.keyboard.press('Enter');
      await page.waitForSelector(actionPopup, { visible: true });
      await page.keyboard.press('Escape');
      await page.waitForSelector(actionPopup, { hidden: true });
      await page.locator(search).fill('missing');
      await page.waitForSelector(`${sidebar} ::-p-text(No matching projects)`, { visible: true });
      await page.$eval(search, (input: HTMLInputElement) => input.select());
      await page.keyboard.press('Backspace');
      await page.waitForSelector(row, { visible: true });
      await page.locator(category).click();
      await page.locator(`${categoryMenu} ::-p-text(Prototype)`).click();
      await page.waitForSelector(`${sidebar} [data-design-project-row="${prototype.id}"]`, { visible: true });
      assert.equal(await page.$(sidebarProject), null);
      await page.locator(category).click();
      const selectedCategory = await page.waitForSelector(`${categoryMenu} [aria-checked="true"]`, { visible: true });
      assert.equal(await selectedCategory!.evaluate(el => el.textContent?.trim()), 'Prototype');
      await page.locator(`${categoryMenu} ::-p-text(All categories)`).click();
      await page.waitForSelector(row, { visible: true });
      await page.click(`${sidebar} button[aria-label="Close project list"]`);
      await page.waitForSelector(sidebar, { hidden: true });
      await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, toggle);
      assert.ok(await page.$eval(`.om-studio-bar ${toggle}`, button => {
        const title = button.closest('.om-studio-bar')!.querySelector('h1')!;
        return button.getBoundingClientRect().right <= title.getBoundingClientRect().left;
      }));
      await checkDesignComposerAlignment(page);
      await page.click(toggle);
      await page.waitForSelector(row, { visible: true });
      await page.click(`${sidebar} button[aria-label="New project"]`);
      await page.waitForSelector('.om-design-popover ::-p-text(Mobile App)', { visible: true });
      await page.keyboard.press('Escape');

      await openActions(`${recentProjects} ${galleryProject}`);
      await selectAction('Duplicate');
      const recentCopyTitle = await page.waitForSelector(`${recentProjects} .om-design-card-title ::-p-text(Mobile app project (Copy))`, { visible: true, timeout: 5000 });
      const recentCopyId = await recentCopyTitle!.evaluate(el => el.closest('[data-design-project-row]')!.getAttribute('data-design-project-row'));
      const recentCopy = `${recentProjects} [data-design-project-row="${recentCopyId}"]`;
      const sidebarCopy = `${sidebar} [data-design-project-row="${recentCopyId}"]`;
      await page.waitForSelector(`${sidebarCopy} button[aria-label="Mobile app project (Copy)"]`, { visible: true, timeout: 5000 });

      await openActions(recentCopy);
      await selectAction('Rename');
      await page.locator(`${recentCopy} input[aria-label="Rename project"]`).fill('Renamed recent project');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${recentCopy} ::-p-text(Renamed recent project)`, { visible: true, timeout: 5000 });
      await page.waitForSelector(`${sidebarCopy} button[aria-label="Renamed recent project"]`, { visible: true, timeout: 5000 });

      await openActions(recentCopy);
      await selectAction('Move to Trash');
      await page.waitForSelector(recentCopy, { hidden: true, timeout: 5000 });
      await page.waitForSelector(sidebarCopy, { hidden: true, timeout: 5000 });
      await page.click(sidebarTrash);
      await page.waitForSelector(sidebarCopy, { visible: true, timeout: 5000 });
      await openActions(sidebarCopy);
      await selectAction('Delete permanently');
      await page.waitForSelector(sidebarCopy, { hidden: true, timeout: 5000 });
      await page.click(sidebarTrash);

      await page.locator('.om-design-page .om-design-section-head ::-p-text(View all)').click();
      await page.waitForFunction(() => document.querySelector('.om-design-hero-title')?.textContent === 'Design projects');
      assert.equal(new URL(page.url()).searchParams.get('scene'), 'projects');
      await page.locator(galleryCategory).click();
      await page.locator(`${categoryMenu} ::-p-text(Prototype)`).click();
      await page.waitForSelector(galleryProject, { hidden: true });
      await page.locator(galleryCategory).click();
      await page.locator(`${categoryMenu} ::-p-text(All categories)`).click();
      await page.waitForSelector(galleryProject, { visible: true });

      await openActions(sidebarProject);
      await selectAction('Rename');
      const rename = `${sidebarProject} input[aria-label="Rename project"]`;
      await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, rename);
      await page.keyboard.press('Escape');
      await page.waitForFunction(selector => document.activeElement?.matches(`${selector} [data-project-actions]`), {}, sidebarProject);
      await openActions(sidebarProject);
      await selectAction('Rename');
      await page.locator(rename).fill('Renamed project');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${sidebarProject} button[aria-label="Renamed project"]`, { visible: true });
      await page.waitForSelector(`${galleryProject} ::-p-text(Renamed project)`, { visible: true });

      for (const [label, format] of [['Export ZIP', 'zip'], ['Export for Open Design', 'open-design']] as const) {
        await openActions(sidebarProject);
        const response = page.waitForResponse(res => new URL(res.url()).pathname === designRoutes.exportProject(project.id));
        await selectAction(label);
        const exported = await response;
        assert.ok(exported.ok());
        assert.equal(JSON.parse(exported.request().postData()!).format, format);
        assert.match(exported.headers()['content-disposition'], /\.zip"/);
      }

      await openActions(galleryProject);
      await selectAction('Duplicate');
      const copy = `${sidebar} button[aria-label="Renamed project (Copy)"]`;
      await page.waitForSelector(copy, { visible: true });
      const copyId = await page.$eval(copy, el => el.closest('[data-design-project-row]')!.getAttribute('data-design-project-row'));
      const copyRow = `${sidebar} [data-design-project-row="${copyId}"]`;
      await openActions(copyRow);
      await selectAction('Move to Trash');
      await page.waitForSelector(copy, { hidden: true });
      await page.click(sidebarTrash);
      await page.waitForSelector(`${copyRow} [data-project-actions]`, { visible: true });
      assert.equal(await page.$(sidebarProject), null);
      await openActions(copyRow);
      await selectAction('Restore');
      await page.waitForSelector(copyRow, { hidden: true });
      await page.waitForSelector(`.om-design-card[data-design-project-row="${copyId}"]`, { visible: true });

      await page.click(sidebarTrash);
      await openActions(copyRow);
      await selectAction('Move to Trash');
      const galleryTrash = '.om-design-header-group ::-p-text(Trash)';
      await page.locator(galleryTrash).click();
      const trashedCard = `.om-design-card[data-design-project-row="${copyId}"]`;
      await page.waitForSelector(`${trashedCard} ::-p-text(Restore)`, { visible: true });
      await page.click(sidebarTrash);
      await openActions(copyRow);
      await selectAction('Delete permanently');
      await page.waitForSelector(`${sidebar} ::-p-text(Trash is empty.)`, { visible: true });
      await page.waitForSelector('.om-design-page ::-p-text(Trash is empty.)', { visible: true });
      assert.equal((await designProjects.list({ trashed: true })).length, 0);
      await page.click(sidebarTrash);

      await page.click('.om-studio-bar ::-p-text(Text to image)');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('scene') === 'text-to-image');
      await page.waitForSelector(sidebarProject, { visible: true });
      assert.equal(await page.$('.om-studio-bar nav ::-p-text(Projects)'), null);

      await page.setViewport({ width: 390, height: 800, hasTouch: true });
      await page.waitForSelector(toggle, { visible: true });
      await page.waitForSelector(sidebar, { hidden: true });
      await page.click(toggle);
      await page.waitForSelector(`${sidebar}[role="dialog"]`, { visible: true });
      await page.waitForFunction(selector => document.querySelector(selector)!.getBoundingClientRect().left >= -0.5, {}, sidebar);
      await page.waitForSelector(actionWrapper, { visible: true });
      assert.equal(await page.$eval(actionWrapper, el => getComputedStyle(el).opacity), '1');
      await page.tap(category);
      await page.waitForSelector(`${categoryMenu} ::-p-text(All categories)`, { visible: true, timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector(categoryMenu, { hidden: true });
      await page.tap(`${sidebarProject} [data-project-actions]`);
      await page.waitForSelector(`${actionPopup} ::-p-text(Export ZIP)`, { visible: true });
      await page.keyboard.press('Escape');
      await page.waitForSelector(actionPopup, { hidden: true });
      await page.waitForSelector(`${sidebar}[role="dialog"]`, { visible: true });
      await page.locator(`${sidebarProject} button[aria-label="Renamed project"]`).setTimeout(5000).click();
      await page.waitForSelector(`[data-design-editor="${project.id}"]`, { visible: true });
      await page.waitForSelector(sidebar, { hidden: true });
    } finally { await browser.close(); await running.close(); }
  });
});

test('Studio controls fit their resizable generator and timeline panes', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('motion.studio.locale', 'en');
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
      });
      await page.setViewport({ width: 1280, height: 800 });
      const url = new URL((await running.info()).previewUrl);
      url.searchParams.set('page', 'cinema');
      url.searchParams.set('scene', 'text-to-video');
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.om-creator-pane .om-asset-direct > button.om-button', { visible: true });
      await page.evaluate(() => document.fonts.ready);
      for (const menuLabel of ['Image · Scenes', 'Video · Scenes', 'Audio · Scenes', 'Generate with Open Design MCP']) {
        const split = '.om-creative-split:has(> [aria-label="' + menuLabel + '"])';
        const popup = '[role="dialog"][aria-label="' + menuLabel + '"]';
        await page.hover(split + ' > .om-nav-row-link');
        await page.waitForSelector(popup, { visible: true });
        await page.hover(split + ' > .om-nav-row-action');
        await page.hover(split + ' > .om-nav-row-link');
        await page.hover(popup + ' button');
        assert.ok(await page.$eval(popup, el => el.matches(':hover')), 'The menu stays open when moving from the label into it');
      }
      await page.mouse.move(5, 750);
      await page.waitForSelector('.om-creative-client-menu', { hidden: true });
      assert.equal(new URL(page.url()).searchParams.get('page'), 'cinema', 'Hovering a destination preserves the current Studio');
      const divider = await page.waitForSelector('.om-creator-pane [role="separator"]');
      for (const [key, width] of [['Home', 310], ['End', 650]] as const) {
        await divider!.press(key);
        await page.waitForFunction(width => document.querySelector('.om-creator-pane [role="separator"]')?.getAttribute('aria-valuenow') === String(width), {}, width);
        await checkCreator(page, key === 'Home');
      }
      await page.setViewport({ width: 320, height: 690 });
      await page.waitForFunction(() => document.querySelector('.om-creator-pane')!.getBoundingClientRect().width <= innerWidth);
      await checkCreator(page, true);
      assert.ok(await page.$eval('.om-studio-bar', bar => {
        const back = bar.querySelector('.om-studio-back')!.getBoundingClientRect();
        const scenes = bar.querySelector('nav')!.getBoundingClientRect();
        return back.bottom <= scenes.top;
      }), 'The mobile Studio header keeps its return action above the scenes');
      const imageNav = '.om-creative-strip > [data-nav-slot]:not([data-stowed]) .om-creative-split:has(> [aria-label="Image · Scenes"])';
      await page.waitForSelector('.om-creative-navigation[data-compact-actions]');
      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await page.waitForSelector(imageNav + ' > .om-nav-row-link', { visible: true });
        await page.click(imageNav + ' > .om-nav-row-link');
        await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === 'design');
        await page.waitForSelector('.om-creative-menu', { hidden: true });
        await page.waitForSelector('.om-generation-pickers [aria-label="Generation model"]', { visible: true });
        await page.mouse.move(5, 675);
        await page.focus(imageNav + ' > .om-nav-row-link');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Image · Scenes');
        await page.keyboard.press('Enter');
        const menu = await page.waitForSelector('.om-creative-menu', { visible: true });
        assert.ok(await menu!.evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth));
        await page.keyboard.press('Escape');
        await page.waitForSelector('.om-creative-menu', { hidden: true });
        await page.goBack();
        await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === 'cinema');
      }
      const more = await page.waitForSelector('::-p-aria([name="More Studio"][role="button"])', { visible: true });
      await more!.focus();
      await page.keyboard.press('Enter');
      const folder = await page.waitForSelector('.om-nav-more-panel [aria-label="Workspace assets"]', { visible: true });
      assert.ok(await folder!.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth;
      }), 'The assets shortcut fits inside the narrow navigation menu');
      await folder!.click();
      await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === 'assets');
      await page.goBack();
      await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === 'cinema');
      await page.setViewport({ width: 320, height: 690, hasTouch: true });
      await page.waitForSelector(imageNav);
      await page.tap(imageNav + ' > .om-nav-row-action');
      await page.waitForSelector('.om-creative-menu', { visible: true });
      await page.tap(imageNav + ' > .om-nav-row-link');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === 'design');
      await page.waitForSelector('.om-creative-menu', { hidden: true });
      await page.goto(new URL('/?page=editor', url).href, { waitUntil: 'domcontentloaded' });
      const toolbar = await page.waitForSelector('.motion-timeline-icon-controls', { visible: true });
      assert.ok(await toolbar!.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('button, input')).filter(control => control.getClientRects().length).every(control => {
          const box = control.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      }), 'All timeline controls fit at the narrowest viewport');
    } finally {
      await browser.close();
      await running.close();
      await gateway.close();
    }
  });
});

test('Explore fills every gallery row and plays the featured artwork in place', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => localStorage.setItem('motion.studio.locale', 'en'));
      const items = Array.from({ length: 10 }, (_, i) => ({ id: 'work-' + i, title: 'Work ' + i, description: 'A product reveal.', kind: 'builtin', tags: [], uses: ['Product launch', 'Partnership announcement'], industries: ['AI & technology', 'Design tools'] }));
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (new URL(request.url()).pathname.endsWith('/template-catalog')) {
          void request.respond({ contentType: 'application/json', body: JSON.stringify({ offset: 0, items, next: null }) });
        } else void request.continue();
      });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const url = new URL((await running.info()).previewUrl);
      url.searchParams.set('page', 'explore');
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.om-feed-group [data-template-id]');
      await page.evaluate(() => document.fonts.ready);
      for (const [width, expectedCards] of [[1512, 8], [1280, 8], [1060, 6], [760, 4], [320, 2]]) {
        await page.setViewport({ width, height: 850 });
        const rowsFill = await page.$eval('.om-feed-group', feed => {
          const bounds = feed.getBoundingClientRect();
          const cards = Array.from(feed.children, card => card.getBoundingClientRect());
          if (getComputedStyle(feed).overflowX === 'auto') {
            return feed.scrollWidth > feed.clientWidth && cards.every(card => card.top === cards[0].top);
          }
          return cards.every((card, index) => {
            const previous = cards[index - 1], next = cards[index + 1];
            const startsRow = !previous || previous.top !== card.top;
            const endsRow = !next || next.top !== card.top;
            return (!startsRow || Math.abs(card.left - bounds.left) < 1) && (!endsRow || Math.abs(card.right - bounds.right) < 1);
          });
        });
        assert.ok(rowsFill, 'Gallery rows follow reading order and fill the available width at ' + width);
        const shelves = await page.$$eval('.om-explore-shelf .om-explore-preview-grid', grids => grids.map(grid => {
          const bounds = grid.getBoundingClientRect();
          const cards = Array.from(grid.children).filter(card => card.getClientRects().length).map(card => card.getBoundingClientRect());
          const rows = new Map<number, DOMRect[]>();
          for (const card of cards) {
            const key = [...rows.keys()].find(top => Math.abs(top - card.top) < 2) ?? card.top;
            rows.set(key, [...(rows.get(key) ?? []), card]);
          }
          const full = [...rows.values()].every(row => Math.abs(row[0].left - bounds.left) < 2 && Math.abs(row.at(-1)!.right - bounds.right) < 2);
          return { count: cards.length, rows: rows.size, full };
        }));
        assert.deepEqual(shelves, [
          { count: expectedCards, rows: 2, full: true },
          { count: expectedCards, rows: 2, full: true },
        ], 'Template and Skill previews fit two complete rows at ' + width);
        const studios = await page.$$eval('.om-studio-collection', sections => sections.map(section => {
          const grid = section.querySelector<HTMLElement>('.om-studio-collection-cards')!;
          const bounds = grid.getBoundingClientRect();
          const cards = Array.from(grid.children).filter(card => card.getClientRects().length).map(card => card.getBoundingClientRect());
          if (getComputedStyle(grid).overflowX === 'auto') {
            return { studio: section.getAttribute('data-studio'), rail: true, full: cards.length > 0 && cards.every(card => Math.abs(card.top - cards[0].top) < 2) };
          }
          const rows = new Map<number, DOMRect[]>();
          for (const card of cards) {
            const key = [...rows.keys()].find(top => Math.abs(top - card.top) < 2) ?? card.top;
            rows.set(key, [...(rows.get(key) ?? []), card]);
          }
          const rowLists = [...rows.values()];
          const full = rowLists.every(row => row.length === rowLists[0].length && Math.abs(row[0].left - bounds.left) < 2 && Math.abs(row.at(-1)!.right - bounds.right) < 2);
          return { studio: section.getAttribute('data-studio'), count: cards.length, rows: rowLists.length, full };
        }));
        assert.ok(studios.length === 8 && studios.every(item => item.full), 'Every Studio collection renders complete rows at ' + width + ': ' + JSON.stringify(studios));
        const toolbarGeometry = await page.$eval('.om-explore-shelf[aria-label="Templates"]', section => {
          const submit = section.querySelector<HTMLAnchorElement>('header a[href*="CONTRIBUTING.md"]');
          const dropdown = section.querySelector<HTMLButtonElement>('.om-shelf-toolbar .om-gallery-dropdown');
          const strip = section.querySelector<HTMLElement>('.om-shelf-toolbar .om-category-strip');
          const dr = dropdown?.getBoundingClientRect();
          const sr = strip?.getBoundingClientRect();
          return {
            hasSubmit: Boolean(submit),
            dropdownSingleLine: Boolean(dr && dr.height <= 40 && dr.right <= innerWidth + 1 && dropdown!.scrollWidth <= dropdown!.clientWidth + 1),
            noHorizontalOverflow: document.querySelector('.om-explore')!.scrollWidth <= document.querySelector('.om-explore')!.clientWidth + 1,
            stripFits: Boolean(sr && sr.left >= 0 && sr.right <= innerWidth + 1),
          };
        });
        assert.deepEqual(toolbarGeometry, { hasSubmit: true, dropdownSingleLine: true, noHorizontalOverflow: true, stripFits: true }, 'Template shelf controls fit on one line at ' + width);
        if (width === 320) {
          const strip = '.om-explore-shelf[aria-label="Templates"] .om-category-strip';
          await page.waitForSelector(strip + ' button[aria-label^="Next"]:enabled');
          assert.equal(await page.$(strip + ' [data-edge="left"]'), null);
          assert.equal(await page.$eval(strip + '-viewport', list => getComputedStyle(list).scrollbarWidth), 'none');
          await page.click(strip + ' button[aria-label^="Next"]');
          await page.waitForFunction(selector => document.querySelector(selector)!.scrollLeft > 0, {}, strip + '-viewport');
          await page.waitForSelector(strip + ' button[aria-label^="Previous"]:enabled');
          await page.$eval(strip + '-viewport', list => { list.scrollLeft = list.scrollWidth; });
          await page.waitForSelector(strip + ' [data-edge="right"]', { hidden: true });
          await page.click(strip + ' [data-edge="left"]');
          await page.waitForSelector(strip + ' [data-edge="right"]');
        }
        const hero = (await page.$('.om-feature-carousel'))!;
        const initialHeight = await hero.evaluate(element => element.getBoundingClientRect().height);
        for (const indicator of await hero.$$('.om-media-segments button')) {
          await indicator.click();
          assert.equal(await hero.evaluate(element => element.getBoundingClientRect().height), initialHeight);
        }
      }
      const rail = '.om-highlights';
      const next = rail + ' [data-edge="right"]', previous = rail + ' [data-edge="left"]';
      await page.waitForSelector(next);
      assert.equal(await page.$(previous), null);
      assert.equal(await page.$eval('.om-stories-rail', list => getComputedStyle(list).scrollbarWidth), 'none');
      await page.click(next);
      await page.waitForSelector(previous);
      assert.ok(await page.$(next), 'Both directions are available between the ends');
      await page.$eval('.om-stories-rail', list => { list.scrollLeft = list.scrollWidth; });
      await page.waitForSelector(next, { hidden: true });
      await page.click(previous);
      await page.waitForSelector(next);
      const artwork = '.om-feature-slide[aria-hidden="false"] .om-feature-camera';
      const cameraState = () => page.$eval(artwork, camera => getComputedStyle(camera).animationPlayState);
      assert.equal(await cameraState(), 'paused', 'Reduced motion starts with a still frame');
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      const segments = await page.$$('.om-media-segments button');
      for (const segment of segments) {
        await segment.click();
        await segment.evaluate(element => (element as HTMLButtonElement).blur());
        const start = await page.$eval(artwork, camera => getComputedStyle(camera).transform);
        await page.waitForFunction((selector, start) => getComputedStyle(document.querySelector(selector)!).transform !== start, {}, artwork, start);
        const scene = await page.$eval('.om-feature-carousel', hero => hero.getAttribute('data-scene'));
        if (scene !== 'shot-image' && scene !== 'black-friday' && scene !== 'hub-gemini-4') {
          await page.waitForFunction(selector => (document.querySelector(selector)?.querySelector('video')?.currentTime ?? 0) > 0.1, {}, artwork);
        }
      }
      await page.focus('.om-media-segments [aria-current]');
      assert.equal(await cameraState(), 'paused');
      assert.ok(await page.$eval(artwork + ' video', video => (video as HTMLVideoElement).paused));
    } finally {
      await browser.close();
      await running.close();
      await gateway.close();
    }
  });
});

test('Sound Studio previews and seeks the welcome track in both wide and compact layouts', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('motion.studio.locale', 'en');
        localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ theme: 'system' }));
      });
      const url = new URL((await running.info()).previewUrl);
      url.searchParams.set('page', 'sound');
      for (const [width, theme] of [[1280, 'dark'], [390, 'light']] as const) {
        await page.setViewport({ width, height: 800 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        if (width < 800) {
          const guide = '.om-assets-view-switch button:first-child';
          await page.waitForSelector(guide, { visible: true });
          await page.click(guide);
        }
        const player = '.om-scene-audio';
        await page.waitForSelector(player + ' input[type="range"]:enabled', { visible: true });
        assert.ok(await page.$eval(player, panel => panel.scrollWidth <= panel.clientWidth && panel.querySelector('audio')!.paused));
        await page.click(player + ' [aria-label="Play"]');
        await page.waitForFunction(() => (document.querySelector<HTMLAudioElement>('.om-scene-audio audio')?.currentTime ?? 0) > 0);
        await page.click(player + ' [aria-label="Pause"]');
        await page.click('.motion-waveform-seek input');
        await page.waitForFunction(() => {
          const audio = document.querySelector<HTMLAudioElement>('.om-scene-audio audio');
          return audio && audio.paused && audio.currentTime > audio.duration * 0.4;
        });
      }
    } finally {
      await browser.close();
      await running.close();
      await gateway.close();
    }
  });
});

test('the opt-in UI inspector outlines component roots, excludes its own controls and follows a modal', { timeout: 60_000 }, async () => {
  await fixture(async store => {
    const running = await startServer(store, 0, { editor: true });
    const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true });
    try {
      const page = await browser.newPage();
      const url = new URL('/', (await running.info()).previewUrl);
      await page.goto(url.href);
      await page.waitForSelector('[data-odui-component="button"]');
      assert.equal(await page.$('.odui-inspector'), null);
      url.searchParams.set('debug', 'ui');
      await page.goto(url.href);
      await page.waitForSelector('.odui-inspector-launcher', { visible: true });
      await page.click('.odui-inspector-launcher');
      const row = '.odui-inspector-row';
      await page.click(row);
      assert.equal(await page.$eval('[data-odui-component="button"]:not(.odui-inspector *)', el => getComputedStyle(el).outlineStyle), 'solid');
      await page.waitForFunction(() =>
        Number(document.querySelector('.odui-inspector-row .odui-count')?.textContent) ===
        document.querySelectorAll('button[data-odui-component="button"]:not(.odui-inspector *)').length);
      await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'inspector-test';
        dialog.innerHTML = '<button>Native</button><div data-odui-component="slider"><input type="range"></div>';
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.waitForSelector('#inspector-test .odui-inspector:popover-open');
      await page.click(row + ':has(.native)');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#inspector-test > button')!).outlineStyle === 'dashed');
      await page.click(row + ':last-child');
      assert.notEqual(await page.$eval('#inspector-test input', el => getComputedStyle(el).outlineStyle), 'dashed');
      await page.click('.odui-inspector-bar button:last-child');
      assert.equal(await page.$('.odui-inspector'), null);
      assert.notEqual(await page.$eval('#inspector-test > button', el => getComputedStyle(el).outlineStyle), 'dashed');
    } finally { await browser.close(); await running.close(); }
  });
});
