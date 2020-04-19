const {
  BaseKonnector,
  requestFactory,
  cozyClient,
  signin,
  saveFiles,
  updateOrCreate,
  log,
  utils
} = require('cozy-konnector-libs')
const format = require('date-fns/format')
const path = require('path')

const request = requestFactory({
  json: true,
  jar: true
})

const VENDOR = 'famileo'
const baseUrl = 'https://www.famileo.com'

module.exports = new BaseKonnector(start)

async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  const families = await fetchFamilies()
  if (families.length === 0) return
  log('info', 'Successfully fetched families')

  for (const family of families) {
    await Promise.all([
      fetchGazettes(family, fields),
      fetchContacts(family),
      fetchPhotos(family, fields)
    ])
  }
}

function authenticate(username, password) {
  return signin({
    url: `${baseUrl}/login`,
    formSelector: 'form',
    formData: { _username: username, _password: password },
    validate: (statusCode, $) => {
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        log('error', $('.ui-pnotify-text').text())
        return false
      }
    }
  })
}

async function fetchFamilies() {
  const response = await request(`${baseUrl}/api/user/pad`)

  if (!response || !response.pads.length) {
    log('debug', response, 'no pads found')
    return []
  }
  return response.pads
}

async function fetchGazettes(family, fields) {
  const response = await request({
    method: 'GET',
    uri: `${baseUrl}/api/gazettes/${family.pad_id}`
  })

  if (!response || !response.gazettes.length) {
    log('debug', response, 'no gazettes found')
    return
  }

  log('info', 'Parsing list of gazettes')
  const documents = parseGazettes(response.gazettes)

  log('info', 'Saving gazettes to Cozy')
  await saveFiles(documents, fields, {
    concurrency: 8,
    subPath: path.join(family.pad_name, 'Gazettes')
  })
}

function parseGazettes(docs) {
  return docs.map(doc => ({
    fileurl: doc.pdf,
    filename: `Gazette du ${utils.formatDate(
      new Date(doc.created_at + 'Z')
    )}.pdf`,
    vendor: VENDOR,
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}

async function fetchContacts(family) {
  const response = await request(
    `${baseUrl}/api/families/${family.pad_id}/members`
  )

  if (!response || !response.family_members.length) {
    // error
    log('debug', response, 'no contacts found')
    return
  }

  log('info', 'Parsing list of contacts')
  const documents = parseContacts(response.family_members)

  log('info', 'Saving contacts to Cozy')
  const contactsDocs = await updateOrCreate(documents, 'io.cozy.contacts', [
    'name.familyName',
    'name.givenName'
  ])

  log('info', 'Creating or updating contact groups')
  const contactsIds = contactsDocs.filter(doc => doc).map(doc => doc._id)
  const groupDocs = await updateOrCreate(
    buildContactGroups(family),
    'io.cozy.contacts.groups',
    ['name']
  )

  for (const groupDoc of groupDocs) {
    const referencedContactsIds = await listAllReferencedDocs(groupDoc)
    const newContactsIds = contactsIds.filter(
      id => !referencedContactsIds.includes(id)
    )
    await cozyClient.data.addReferencedFiles(groupDoc, newContactsIds)
  }
}

function parseContacts(docs) {
  return docs.map(doc => ({
    name: {
      familyName: doc.lastname,
      givenName: doc.firstname
    },
    birthday: doc.birthday.split(' ')[0],
    email: [{ address: doc.email, type: 'home', label: 'Personnel' }],
    metadata: {
      importDate: new Date(),
      version: 1,
      [VENDOR]: {
        id: doc.id
      }
    }
  }))
}

function buildContactGroups(family) {
  return [
    {
      name: 'Famille',
      metadata: {
        importDate: new Date(),
        version: 1
      }
    },
    {
      name: `Famille de ${family.pad_name}`,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }
  ]
}

async function fetchPhotos(family, fields) {
  const response = await request({
    uri: `${baseUrl}/api/galleries/${family.pad_id}`,
    qs: {
      type: 'all'
    }
  })

  if (!response || !response.gallery.length) {
    log('debug', response, 'no photos found')
    return
  }

  let documents = response.gallery
  while (documents.length < response.nb_all_image) {
    const response = await request({
      uri: `${baseUrl}/api/galleries/${family.pad_id}`,
      qs: {
        type: 'all',
        timestamp: documents[documents.length - 1].created_at.replace(' ', '+')
      }
    })

    if (!response || !response.gallery.length) {
      log('debug', response, 'no photos found')
      break
    }

    documents = documents.concat(response.gallery)
  }

  if (!documents.length) {
    log('debug', 'no photos to save')
    return
  }

  const albumName = `Famileo - Famille de ${family.pad_name}`
  const picturesObjects = parsePhotos(documents)
  const picturesDocs = await saveFiles(picturesObjects, fields, {
    concurrency: 8,
    contentType: 'image/jpeg',
    fileIdAttributes: ['famileo_id'],
    subPath: path.join(family.pad_name, 'Photos')
  })
  const picturesIds = picturesDocs
    .filter(doc => doc && doc.fileDocument)
    .map(doc => doc.fileDocument._id)

  const [albumDoc] = await updateOrCreate(
    [{ name: albumName, created_at: family.created_at }],
    'io.cozy.photos.albums',
    ['name']
  )

  const referencedFileIds = await listAllReferencedDocs(albumDoc)
  const newFileIds = picturesIds.filter(id => !referencedFileIds.includes(id))
  await cozyClient.data.addReferencedFiles(albumDoc, newFileIds)
}

function parsePhotos(docs) {
  return docs.map(doc => {
    log('debug', doc, 'photo')
    log('debug', doc.image, 'url')
    log('debug', doc.image.match(/\/\d{4}\/\d{2}\/(.*)_/), 'id')

    const fileurl = doc.image
    const extension = path.extname(fileurl)
    const famileo_id = doc.image.match(/\/\d{4}\/\d{2}\/(.*)_/)[1]
    const time = new Date(doc.created_at + 'Z')
    const author = `${doc.firstname} ${doc.lastname}`.trim().replace(/ /g, '_')
    const filename = `${format(
      time,
      'yyyy_MM_dd'
    )}-${author}-${famileo_id}${extension}`
    return {
      fileurl,
      filename,
      famileo_id,
      fileAttributes: {
        lastModifiedDate: time
      }
    }
  })
}

async function listAllReferencedDocs(doc) {
  let list = []
  let result = {
    links: {
      next: `/data/${encodeURIComponent(doc._type)}/${
        doc._id
      }/relationships/references`
    }
  }
  while (result.links.next) {
    result = await cozyClient.fetchJSON('GET', result.links.next, null, {
      processJSONAPI: false
    })
    list = list.concat(result.data)
  }

  return list.map(doc => doc.id)
}
