const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  updateOrCreate,
  cozyClient,
  signin,
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
  const response = await request(`${baseUrl}/api/gazettes/${family.pad_id}`)

  if (!response || !response.gazettes.length) {
    log('debug', response, 'no gazettes found')
    return
  }

  log('info', 'Parsing list of gazettes')
  const documents = response.gazettes.map(parseGazette)

  log('info', 'Saving gazettes to Cozy')
  await saveFiles(documents, fields, {
    concurrency: 8,
    subPath: path.join(family.pad_name, 'Gazettes')
  })
}

function parseGazette(doc) {
  return {
    fileurl: doc.pdf,
    filename: `Gazette du ${utils.formatDate(new Date(doc.created_at))}.pdf`,
    vendor: VENDOR,
    metadata: {
      [VENDOR]: {
        gazette_id: doc.id
      }
    }
  }
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
  const documents = response.family_members.map(parseContact)

  log('info', 'Saving contacts to Cozy')
  await updateOrCreate(documents, 'io.cozy.contacts', [
    'name.familyName',
    'name.givenName'
  ])
}

function parseContact(doc) {
  return {
    name: {
      familyName: doc.lastname,
      givenName: doc.firstname
    },
    birthday: doc.birthday.split(' ')[0],
    email: [{ address: doc.email, type: 'home', label: 'Personnel' }],
    metadata: {
      [VENDOR]: {
        family_member_id: doc.id
      }
    }
  }
}

async function fetchPhotos(family, fields) {
  log('info', 'Fetching list of posts')
  const posts = await fetchAllPosts(family)
  log('info', `Found ${posts.length} posts`)

  log('info', 'Parsing list of posts')
  const picturesObjects = posts.map(parsePost).filter(o => o)
  if (!picturesObjects.length) {
    log('debug', 'no photos to save')
    return
  }

  log('info', 'Looking for photos album')
  const albumName = `Famileo - Famille de ${family.pad_name}`
  const album = await findOrCreateAlbum(albumName)
  log('debug', 'Using album', { album })
  // TODO: wip
  //const albums = []

  const pictures = await saveFiles(picturesObjects, fields, {
    concurrency: 8,
    contentType: 'image/jpeg',
    subPath: path.join(family.pad_name, 'Photos')
  })
  log('info', `${pictures.length} photos processed`)

  const referencedFileIds = await listAllReferencedDocs(album)
  const newFiles = pictures
    .map(picture => picture.fileDocument)
    .filter(file => file && !referencedFileIds.includes(file._id))
  log('info', `Adding ${newFiles.length} photos to album`)
  await cozyClient.data.addReferencedFiles(
    album,
    newFiles.map(file => file._id)
  )
}

async function fetchAllPosts(family) {
  let response = await request({
    uri: `${baseUrl}/api/families/${family.pad_id}/posts`,
    qs: { type: 'all' }
  })

  if (!response || !response.familyWall || !response.familyWall.length) {
    log('debug', response, 'no posts found')
    return
  }

  let posts = []
  while (response && response.familyWall && response.familyWall.length) {
    posts = posts.concat(response.familyWall)

    response = await request({
      uri: `${baseUrl}/api/families/${family.pad_id}/posts`,
      qs: {
        timestamp: posts[posts.length - 1].date
      }
    })
  }

  return posts
}

async function findOrCreateAlbum(name) {
  if (!name) {
    log('error', 'Missing album name')
    return
  }

  const matchingAlbums = await utils.queryAll('io.cozy.photos.albums', {
    name
  })

  if (matchingAlbums.length) {
    return matchingAlbums[0]
  }

  log('info', 'Album not found. Creating it')
  const created_at = new Date().toISOString()
  const [album] = await updateOrCreate(
    [{ name, created_at }],
    'io.cozy.photos.albums',
    ['name']
  )
  return album
}

function parsePost(doc) {
  log('debug', doc, 'Parsing post')
  log('debug', doc.full_image, 'url')

  const {
    full_image: fileurl,
    wall_post_id: post_id,
    date: creationDate,
    updated_at: updateDate,
    author_name,
    author_id,
    gazette_id,
    text
  } = doc

  if (!fileurl) {
    log('debug', 'Skipping post without image')
    return
  }

  const extension = path.extname(fileurl)
  const created_at = new Date(creationDate + 'Z')
  const updated_at = new Date(updateDate + 'Z')
  const author = author_name.trim().replace(/ /g, '_')
  const filename = `${post_id}-${format(
    created_at,
    'yyyy_MM_dd'
  )}-${author}${extension}`

  return {
    fileurl,
    filename,
    fileAttributes: {
      post_id,
      created_at,
      lastModifiedDate: updated_at
    },
    metadata: {
      [VENDOR]: {
        post_id,
        author_id,
        author_name,
        gazette_id,
        created_at,
        updated_at,
        text
      }
    }
  }
}

async function listAllReferencedDocs(doc) {
  log('info', 'Listing photos within album')
  let list = []
  let result = {
    links: {
      next: `/data/${encodeURIComponent(doc._type)}/${
        doc._id
      }/relationships/references`
    }
  }
  while (result.links && result.links.next) {
    result = await cozyClient.fetchJSON('GET', result.links.next, null, {
      processJSONAPI: false
    })
    if (result.data) {
      list = list.concat(result.data)
    }
  }

  return list.map(doc => doc.id)
}
