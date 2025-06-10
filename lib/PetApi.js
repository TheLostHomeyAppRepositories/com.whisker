'use strict';

const fetch = require('node-fetch');
const CognitoSession = require('./CognitoSession');
const jwt = require('jsonwebtoken');

const PET_ENDPOINT = 'https://pet-profile.iothings.site/graphql';

class PetApi {
  constructor({ tokens, log = console.log, error = console.error } = {}) {
    if (!tokens) {
      throw new Error('Tokens are required for PetApi');
    }
    this.tokens = { ...tokens };
    this.cognitoSession = new CognitoSession({ tokens });
    this.endpoint = PET_ENDPOINT;
    this.log = log;
    this.error = error;
  }

  /**
   * Get HTTP headers for authenticated requests, refreshing the token if it's expiring soon.
   * @returns {Promise<object>}
   */
  async getAuthHeaders() {
    let token = this.cognitoSession.getIdToken();
    if (!token) {
      throw new Error('No valid ID token, please login first');
    }
    const decodedToken = jwt.decode(token);
    if (!decodedToken || !decodedToken.exp) {
      throw new Error('Invalid ID token: cannot decode expiration');
    }
    const exp = decodedToken.exp;
    const now = Math.floor(Date.now() / 1000);
    if (exp - now < 30) {
      this.log('ID token expiring soon, attempting refresh');
      try {
        await this.cognitoSession.refreshSession();
      } catch (err) {
        this.error({ err }, 'Failed to refresh Cognito session');
        throw new Error('Session expired and could not be refreshed. Please repair device.');
      }
      token = this.cognitoSession.getIdToken();
      this.log('Refreshed ID Token');
      if (this.tokens) {
        this.tokens.id_token = token;
        this.tokens.access_token = this.cognitoSession.getAccessToken();
      }
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Perform a GraphQL query, retrying once after refreshing the token on 401.
   * @param {string} query
   * @param {object} variables
   * @param {boolean} retry
   * @returns {Promise<any>}
   */
  async fetchGraphQL(query, variables = {}, retry = true) {
    const headers = await this.getAuthHeaders();
    this.log('GraphQL Request Headers - PetApi', {
      Authorization: 'REDACTED',
      'Content-Type': headers['Content-Type'],
    });

    // Extract operation name for logging
    const opMatch = query.match(/\b(query|mutation)\s+(\w+)/);
    const operationName = opMatch ? opMatch[2] : 'unknown';
    this.log(`GraphQL Request: ${operationName}`, { variables });

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new Error(`Network error during Pet GraphQL request: ${err.message}`);
    }

    const text = await res.text();
    if (!text) {
      throw new Error('Empty response received from Pet GraphQL service');
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse Pet GraphQL response as JSON: ${err.message}\nRaw response: ${text}`);
    }

    this.log({ status: res.status, data: json.data }, 'GraphQL Response - PetApi');

    if (res.status === 401 && retry) {
      this.log('Unauthorized response - refreshing session and retrying (PetApi)');
      try {
        await this.cognitoSession.refreshSession();
      } catch (err) {
        this.error({ err }, 'Failed to refresh Cognito session on 401 (PetApi)');
        throw new Error('Session expired and could not be refreshed. Please repair device.');
      }
      const newIdToken = this.cognitoSession.getIdToken();
      if (this.tokens) {
        this.tokens.id_token = newIdToken;
        this.tokens.access_token = this.cognitoSession.getAccessToken();
      }
      return this.fetchGraphQL(query, variables, false);
    }

    if (!res.ok) {
      this.error(`GraphQL error response: ${text}`);
      throw new Error(`GraphQL query failed with status ${res.status}: ${text}`);
    }

    if (json.errors && json.errors.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    return json;
  }

  /**
   * Retrieve all pets for the authenticated user.
   * @returns {Promise<Array>}
   */
  async getPets() {
    try {
      const idToken = this.cognitoSession.getIdToken();
      if (!idToken) {
        throw new Error('No valid ID token available');
      }
      const decoded = jwt.decode(idToken);
      const userId = decoded?.mid;
      if (!userId) {
        throw new Error('Unable to extract userId (mid) from ID token');
      }

      const query = `
        query GetPetsByUser($userId: String!) {
          getPetsByUser(userId: $userId) {
            petId
            userId
            createdAt
            name
            type
            gender
            weight
            weightLastUpdated
            lastWeightReading
            breeds
            age
            birthday
            adoptionDate
            s3ImageURL
            diet
            isFixed
            environmentType
            healthConcerns
            isActive
            whiskerProducts
            petTagId
            weightIdFeatureEnabled
          }
        }
      `;
      const variables = { userId };
      const result = await this.fetchGraphQL(query, variables);
      const pets = result.data.getPetsByUser || [];
      this.log(`Fetched ${pets.length} pets`);
      return pets;
    } catch (err) {
      this.error({ err }, 'Failed to fetch pets');
      throw err;
    }
  }

  /**
   * Return the current Cognito token set.
   * @returns {{ access_token: string, id_token: string, refresh_token: string } | null}
   */
  getTokens() {
    return this.tokens;
  }
}

module.exports = PetApi;