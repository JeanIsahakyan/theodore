use serde::Deserialize;
use serde_json::json;

const DEFAULT_ENDPOINT: &str = "https://api.linear.app/graphql";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LinearError {
    #[error("network error: {0}")]
    Network(String),
    /// The token is missing, revoked or malformed.
    #[error("linear rejected the token")]
    Auth,
    #[error("linear graphql error: {0}")]
    GraphQl(String),
    #[error("unexpected linear response: {0}")]
    Protocol(String),
}

/// The authenticated user and workspace, for the Settings connect card.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearViewer {
    pub name: String,
    pub email: String,
    pub workspace: String,
}

/// An issue fetched by identifier.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearIssueData {
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub state_name: String,
    /// Linear's `WorkflowState.type`: `triage`, `backlog`, `unstarted`,
    /// `started`, `completed` or `canceled`.
    pub state_type: String,
    pub assignee: Option<String>,
    /// Linear's 0 (no priority) .. 4 (low) scale, passed through as-is.
    pub priority: Option<u8>,
    pub team_key: String,
}

/// A small GraphQL client for Linear's single endpoint. One instance per
/// token (plan "Linear"): `theodore-app` builds a fresh one whenever the
/// stored token changes rather than mutating this one in place.
pub struct LinearClient {
    http: reqwest::Client,
    endpoint: String,
    token: String,
}

impl LinearClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_endpoint(token, DEFAULT_ENDPOINT.to_string())
    }

    /// Points at a different endpoint (a wiremock server in tests).
    pub fn with_endpoint(token: impl Into<String>, endpoint: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            endpoint,
            token: token.into(),
        }
    }

    async fn query<T: serde::de::DeserializeOwned>(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<T, LinearError> {
        let resp = self
            .http
            .post(&self.endpoint)
            // Linear's personal API keys are sent bare, with no `Bearer`
            // prefix — `reqwest::RequestBuilder::bearer_auth` would be wrong.
            .header("authorization", &self.token)
            .header("content-type", "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| LinearError::Network(e.to_string()))?;

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(LinearError::Auth);
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| LinearError::Protocol(e.to_string()))?;

        if let Some(errors) = body.get("errors").and_then(|e| e.as_array())
            && let Some(first) = errors.first()
        {
            let msg = first
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            let is_auth = errors.iter().any(|e| {
                let code = e
                    .get("extensions")
                    .and_then(|x| x.get("code"))
                    .and_then(|c| c.as_str());
                matches!(code, Some("AUTHENTICATION_ERROR"))
                    || e.get("type").and_then(|t| t.as_str()) == Some("AuthenticationError")
            });
            return Err(if is_auth {
                LinearError::Auth
            } else {
                LinearError::GraphQl(msg)
            });
        }

        let data = body
            .get("data")
            .cloned()
            .ok_or_else(|| LinearError::Protocol("response had no data field".into()))?;
        serde_json::from_value(data).map_err(|e| LinearError::Protocol(e.to_string()))
    }

    /// Validates the token and reports who it belongs to (plan
    /// `set_linear_token`: stored only once this succeeds).
    pub async fn viewer(&self) -> Result<LinearViewer, LinearError> {
        #[derive(Deserialize)]
        struct Data {
            viewer: Viewer,
            organization: Org,
        }
        #[derive(Deserialize)]
        struct Viewer {
            name: String,
            email: String,
        }
        #[derive(Deserialize)]
        struct Org {
            name: String,
        }

        let data: Data = self
            .query(
                "query { viewer { name email } organization { name } }",
                json!({}),
            )
            .await?;
        Ok(LinearViewer {
            name: data.viewer.name,
            email: data.viewer.email,
            workspace: data.organization.name,
        })
    }

    /// Fetches one issue by its identifier (`ENG-123`); Linear's `issue`
    /// query accepts both a UUID and an identifier for `id`. Returns `None`
    /// (not an error) when the identifier doesn't resolve to an issue.
    pub async fn issue(&self, identifier: &str) -> Result<Option<LinearIssueData>, LinearError> {
        #[derive(Deserialize)]
        struct Data {
            issue: Option<RawIssue>,
        }
        #[derive(Deserialize)]
        struct RawIssue {
            identifier: String,
            title: String,
            url: String,
            #[serde(default)]
            priority: Option<f64>,
            state: RawState,
            assignee: Option<RawAssignee>,
            team: RawTeam,
        }
        #[derive(Deserialize)]
        struct RawState {
            name: String,
            #[serde(rename = "type")]
            kind: String,
        }
        #[derive(Deserialize)]
        struct RawAssignee {
            name: String,
        }
        #[derive(Deserialize)]
        struct RawTeam {
            key: String,
        }

        const QUERY: &str = r#"query($id: String!) {
            issue(id: $id) {
                identifier
                title
                url
                priority
                state { name type }
                assignee { name }
                team { key }
            }
        }"#;

        let data: Data = match self.query(QUERY, json!({ "id": identifier })).await {
            Ok(d) => d,
            // Linear answers an unknown identifier with a GraphQL error
            // (`Entity not found`) rather than `issue: null` — treat that
            // one case as "no such issue", not a hard failure.
            Err(LinearError::GraphQl(msg)) if msg.to_lowercase().contains("not found") => {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };

        Ok(data.issue.map(|i| LinearIssueData {
            identifier: i.identifier,
            title: i.title,
            url: i.url,
            state_name: i.state.name,
            state_type: i.state.kind,
            assignee: i.assignee.map(|a| a.name),
            priority: i.priority.map(|p| p.clamp(0.0, 255.0) as u8),
            team_key: i.team.key,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn server() -> MockServer {
        MockServer::start().await
    }

    fn client(server: &MockServer, token: &str) -> LinearClient {
        LinearClient::with_endpoint(token.to_string(), server.uri())
    }

    #[tokio::test]
    async fn viewer_returns_user_and_workspace() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("viewer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "viewer": { "name": "Ada Lovelace", "email": "ada@example.com" },
                    "organization": { "name": "Analytical Engines" }
                }
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_test");
        let v = c.viewer().await.unwrap();
        assert_eq!(v.name, "Ada Lovelace");
        assert_eq!(v.email, "ada@example.com");
        assert_eq!(v.workspace, "Analytical Engines");
    }

    #[tokio::test]
    async fn viewer_sends_a_bare_authorization_header_with_no_bearer_prefix() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .and(wiremock::matchers::header(
                "authorization",
                "lin_api_abc123",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "viewer": { "name": "Ada", "email": "ada@example.com" },
                    "organization": { "name": "Org" }
                }
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_abc123");
        assert!(c.viewer().await.is_ok());
    }

    #[tokio::test]
    async fn viewer_surfaces_auth_errors() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "Authentication required", "extensions": { "code": "AUTHENTICATION_ERROR" } }]
            })))
            .mount(&server)
            .await;

        let c = client(&server, "bad-token");
        assert_eq!(c.viewer().await.unwrap_err(), LinearError::Auth);
    }

    #[tokio::test]
    async fn viewer_surfaces_a_401_as_auth_error() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let c = client(&server, "bad-token");
        assert_eq!(c.viewer().await.unwrap_err(), LinearError::Auth);
    }

    #[tokio::test]
    async fn issue_returns_the_mapped_fields() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("issue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "issue": {
                        "identifier": "ENG-123",
                        "title": "Fix the thing",
                        "url": "https://linear.app/acme/issue/ENG-123",
                        "priority": 2,
                        "state": { "name": "In Progress", "type": "started" },
                        "assignee": { "name": "Ada Lovelace" },
                        "team": { "key": "ENG" }
                    }
                }
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_test");
        let issue = c.issue("ENG-123").await.unwrap().unwrap();
        assert_eq!(issue.identifier, "ENG-123");
        assert_eq!(issue.title, "Fix the thing");
        assert_eq!(issue.url, "https://linear.app/acme/issue/ENG-123");
        assert_eq!(issue.priority, Some(2));
        assert_eq!(issue.state_name, "In Progress");
        assert_eq!(issue.state_type, "started");
        assert_eq!(issue.assignee, Some("Ada Lovelace".to_string()));
        assert_eq!(issue.team_key, "ENG");
    }

    #[tokio::test]
    async fn issue_with_no_assignee_or_priority_decodes_fine() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "issue": {
                        "identifier": "ENG-124",
                        "title": "Untriaged",
                        "url": "https://linear.app/acme/issue/ENG-124",
                        "priority": null,
                        "state": { "name": "Backlog", "type": "backlog" },
                        "assignee": null,
                        "team": { "key": "ENG" }
                    }
                }
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_test");
        let issue = c.issue("ENG-124").await.unwrap().unwrap();
        assert_eq!(issue.assignee, None);
        assert_eq!(issue.priority, None);
    }

    #[tokio::test]
    async fn issue_returns_none_when_the_identifier_is_unknown() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "issue": null },
                "errors": [{ "message": "Entity not found" }]
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_test");
        assert_eq!(c.issue("ENG-999").await.unwrap(), None);
    }

    #[tokio::test]
    async fn issue_propagates_a_non_not_found_graphql_error() {
        let server = server().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "Internal server error" }]
            })))
            .mount(&server)
            .await;

        let c = client(&server, "lin_api_test");
        let err = c.issue("ENG-1").await.unwrap_err();
        assert!(matches!(err, LinearError::GraphQl(_)));
    }
}
