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
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  //cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: true,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'famileo'
const baseUrl = 'https://www.famileo.com'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
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
      fetchPhotos(family, fields),
      fetchBills()
    ])
  }
}

// This shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return signin({
    url: `${baseUrl}/login`,
    formSelector: 'form',
    formData: { _username: username, _password: password },
    // The validate function will check if the login request was a success. Every website has a
    // different way to respond: HTTP status code, error message in HTML ($), HTTP redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      log(
        'debug',
        fullResponse.request.uri.href,
        'not used here but should be useful for other connectors'
      )
      // The login in toscrape.com always works except when no password is set
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('.ui-pnotify-text').text())
        return false
      }
    }
  })
}

async function fetchFamilies() {
  const response = await request({
    method: 'GET',
    uri: `${baseUrl}/api/user/pad`,
    headers: {
      Accept: 'application/json'
    },
    body: {}
  })

  if (!response || !response.pads.length) {
    log('debug', response, 'no pads found')
    return []
  }
  return response.pads
}

async function fetchGazettes(family, fields) {
  const response = await request({
    method: 'GET',
    uri: `${baseUrl}/api/gazettes/${family.pad_id}`,
    headers: {
      Accept: 'application/json'
    },
    body: {}
  })

  if (!response || !response.gazettes.length) {
    // error
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
      // It can be interesting to add the date of import. This is not mandatory but may be
      // useful for debugging or data migration
      importDate: new Date(),
      // Document version, useful for migration after change of document structure
      version: 1
    }
  }))
}

async function fetchContacts(family) {
  const response = await request({
    method: 'GET',
    uri: `${baseUrl}/api/families/${family.pad_id}/members`,
    headers: {
      Accept: 'application/json'
    },
    body: {}
  })

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
      // It can be interesting to add the date of import. This is not mandatory but may be
      // useful for debugging or data migration
      importDate: new Date(),
      // Document version, useful for migration after change of document structure
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
        // It can be interesting to add the date of import. This is not mandatory but may be
        // useful for debugging or data migration
        importDate: new Date(),
        // Document version, useful for migration after change of document structure
        version: 1
      }
    },
    {
      name: `Famille de ${family.pad_name}`,
      metadata: {
        // It can be interesting to add the date of import. This is not mandatory but may be
        // useful for debugging or data migration
        importDate: new Date(),
        // Document version, useful for migration after change of document structure
        version: 1
      }
    }
  ]
}

async function fetchPhotos(family, fields) {
  const response = await request({
    method: 'GET',
    uri: `${baseUrl}/api/galleries/${family.pad_id}`,
    headers: {
      Accept: 'application/json'
    },
    qs: {
      type: 'all'
    },
    body: {}
  })

  if (!response || !response.gallery.length) {
    // error
    log('debug', response, 'no photos found')
    return
  }

  let documents = response.gallery
  while (documents.length < response.nb_all_image) {
    const response = await request({
      method: 'GET',
      uri: `${baseUrl}/api/galleries/${family.pad_id}`,
      headers: {
        Accept: 'application/json'
      },
      qs: {
        type: 'all',
        timestamp: documents[documents.length - 1].created_at.replace(' ', '+')
      },
      body: {}
    })

    if (!response || !response.gallery.length) {
      // error
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

async function fetchBills() {
  /*
  await saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['books'],
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
  */
  return
}
