import assert from 'node:assert/strict'
import test from 'node:test'
import { makePreview } from './static-site-publish-preview.js'

test('preview reports record edits, deletions, additions, and image URL changes', () => {
  const before = {
    catalog: {
      sections: [{ id: 1, name: 'Old section' }],
      lessons: [{ id: 11, title: 'Old lesson' }],
      manual_variants: [],
      settings: { theme: 'old' },
    },
    questions: [{
      id: 1,
      question_source: 'base',
      text: { 'uz-Latn': 'Old question' },
      images: [{ id: 'image-1', role: 'question', storage_url: 'https://old/image.png' }],
    }],
    lessonQuestionOrder: [{
      question_source: 'base',
      question_id: 1,
      lesson_id: 11,
      sort_order: 0,
    }],
  }
  const after = {
    catalog: {
      sections: [{ id: 1, name: 'Updated section' }, { id: 2, name: 'New section' }],
      lessons: [
        { id: 11, title: 'Updated lesson' },
        { id: 12, title: 'Deleted lesson', is_deleted: true },
      ],
      manual_variants: [],
      settings: { theme: 'new' },
    },
    questions: [
      {
        id: 1,
        question_source: 'base',
        text: { 'uz-Latn': 'Updated question' },
        images: [{ id: 'image-1', role: 'question', storage_url: 'https://new/image.png' }],
      },
      { id: 2, question_source: 'base', is_deleted: true, images: [] },
    ],
    lessonQuestionOrder: [{
      question_source: 'base',
      question_id: 1,
      lesson_id: 11,
      sort_order: 1,
    }],
  }

  const preview = makePreview(before, after, 'old-version', 'new-version', '{"snapshot":true}\n')
  const group = (title) => preview.changes.find((item) => item.title === title)

  assert.equal(preview.hasChanges, true)
  assert.equal(preview.totalChanges, 8)
  assert.equal(group('Bo‘limlar').added, 1)
  assert.equal(group('Bo‘limlar').updated, 1)
  assert.equal(group('Darslar').deleted, 1)
  assert.equal(group('Savollar').deleted, 1)
  assert.equal(group('Savollar').updated, 1)
  assert.equal(group('Savol tartibi').updated, 1)
  assert.equal(group('Sozlamalar').updated, 1)
  assert.deepEqual(preview.imageChanges, { added: 0, updated: 1, deleted: 0 })
  assert.equal(preview.snapshotBytes, Buffer.byteLength('{"snapshot":true}\n'))
})

test('preview reports no upload when the GitHub snapshot already matches', () => {
  const snapshot = {
    catalog: { sections: [], lessons: [], manual_variants: [], settings: {} },
    questions: [],
    lessonQuestionOrder: [],
  }

  const preview = makePreview(snapshot, snapshot, 'same-version', 'same-version', '{}\n')

  assert.equal(preview.hasChanges, false)
  assert.equal(preview.totalChanges, 0)
  assert.equal(preview.snapshotBytes, 0)
  assert.deepEqual(preview.changes, [])
})
