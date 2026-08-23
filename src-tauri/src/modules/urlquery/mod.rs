use crate::module::ModuleBackend;

pub struct UrlQueryModule;
impl ModuleBackend for UrlQueryModule {
    fn id(&self) -> &'static str {
        "urlquery"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
