import { expect, it } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { facetValues } from './templateDiscovery';

const template = { id: 'new', brand: 'Figma', uses: [], industries: [] } as unknown as GalleryTemplate;

it('normalizes localized uses into stable, meaningful video purposes', () => {
  expect(facetValues({ ...template, uses: ['Product launch', 'Brand promotion'] }, 'uses')).toEqual(['Product launch films', 'Brand & company films']);
  expect(facetValues({ ...template, uses: ['产品发布', '品牌宣传'] }, 'uses')).toEqual(['Product launch films', 'Brand & company films']);
  expect(facetValues({ ...template, uses: ['A new published use'] }, 'uses')).toEqual(['A new published use']);
});

it('merges the published plural launch label with localized and canonical purposes', () => {
  for (const value of ['Product launches', 'Product launch', '产品发布', 'Product launch films', '产品发布宣传片']) {
    expect(facetValues({ ...template, uses: [value] }, 'uses')).toEqual(['Product launch films']);
  }
  expect(facetValues({ ...template, uses: ['Product launches', '产品发布', 'Product launch films', 'A new published use'] }, 'uses'))
    .toEqual(['Product launch films', 'A new published use']);
});

it('identifies reviewed fundraising entries without classifying every milestone as fundraising', () => {
  const item = { ...template, uses: ['Milestones and results'] };
  expect(facetValues(item, 'uses')).toEqual(['Milestones & results']);
  expect(facetValues({ ...item, id: 'motion-7b279560-81df-4c31-988d-473d35536c28' }, 'uses')).toEqual(['Fundraising announcements', 'Milestones & results']);
});

it('prefers published industries and leaves unreviewed brands unclassified', () => {
  expect(facetValues(template, 'industries')).toEqual(['Design & creative tools']);
  expect(facetValues({ ...template, industries: ['Education'] }, 'industries')).toEqual(['Education']);
  expect(facetValues({ ...template, brand: 'Unknown brand' }, 'industries')).toEqual([]);
});
